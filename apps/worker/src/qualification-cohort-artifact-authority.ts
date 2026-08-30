/* oxlint-disable effecttsgo/async-function, osfo/no-unknown-parameters -- Cloudflare owns the Promise-native RPC trust boundary and inputs are schema-decoded immediately. */
import { DurableObject } from "cloudflare:workers";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { qualificationChecksum } from "./qualification/qualification-checksum";
import {
  decodeQualificationCohortArtifactFenceInput,
  decodeQualificationCohortArtifactRetainInput,
  qualificationCohortArtifactProtocol,
  type QualificationCohortArtifactFamily,
  type QualificationCohortArtifactFenceOutcome,
  type QualificationCohortArtifactRetainOutcome,
} from "./qualification/cohort-artifact-authority-contract";

interface AuthorityEnv {
  readonly ARTIFACTS: R2Bucket;
}

interface AuthorityStateRow extends Record<string, SqlStorageValue> {
  readonly execution_id: string;
  readonly lifecycle: "FENCED" | "OPEN";
  readonly protocol_version: string;
}

interface ArtifactRow extends Record<string, SqlStorageValue> {
  readonly artifact_key: string;
  readonly body_sha256: string;
  readonly family: QualificationCohortArtifactFamily;
  readonly metadata_digest: string;
  readonly operation_token: string;
}

type PendingRow = ArtifactRow;

const familyKind = {
  finalizePage: "qualification-cohort-finalize-page-v1",
  inventoryReceipt: "qualification-cohort-inventory-v1",
  manifest: "qualification-cohort-v1",
  participantGrant: "qualification-participant-grant-v1",
  provisionPage: "qualification-cohort-provision-page-v1",
} as const satisfies Record<QualificationCohortArtifactFamily, string>;

const bodySha256 = async (body: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
};

const exactKeyForFamily = (
  executionId: string,
  family: QualificationCohortArtifactFamily,
  key: string,
): boolean => {
  const prefix = `qualification/executions/${encodeURIComponent(executionId)}/cohort/`;
  if (!key.startsWith(prefix)) return false;
  const suffix = key.slice(prefix.length);
  if (family === "manifest") return key === `${prefix}manifest.json`;
  if (family === "inventoryReceipt") return key === `${prefix}inventory-receipt.json`;
  if (family === "provisionPage") return /^provision-pages\/[0-9]{8}\.json$/u.test(suffix);
  if (family === "participantGrant") {
    return /^grants\/(?:free|adventurer)\/[0-9]{8}\.json$/u.test(suffix);
  }
  return /^finalize-pages\/(?:free|adventurer)\/[0-9]{8}\.json$/u.test(suffix);
};

const validMetadata = (metadata: Readonly<Record<string, string>>): boolean => {
  const entries = Object.entries(metadata);
  return (
    entries.length > 0 &&
    entries.length <= 20 &&
    entries.every(([key, value]) => key.length > 0 && key.length <= 128 && value.length <= 512) &&
    new TextEncoder().encode(entries.flat().join("")).byteLength <= 1_800
  );
};

const conflict = (code: string): QualificationCohortArtifactRetainOutcome => ({
  _tag: "Conflict",
  code,
});

/** Exclusive, execution-scoped mutation owner for disposable cohort R2 artifacts. */
export class QualificationCohortArtifactAuthority extends DurableObject<AuthorityEnv> {
  #active = false;

  constructor(ctx: DurableObjectState, env: AuthorityEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        create table if not exists authority_state (
          singleton integer primary key check (singleton = 1),
          execution_id text not null,
          protocol_version text not null,
          lifecycle text not null check (lifecycle in ('OPEN', 'FENCED'))
        );
        create table if not exists artifact_records (
          artifact_key text primary key,
          family text not null,
          body_sha256 text not null,
          metadata_digest text not null,
          operation_token text not null unique
        );
        create table if not exists pending_intent (
          singleton integer primary key check (singleton = 1),
          artifact_key text not null,
          family text not null,
          body_sha256 text not null,
          metadata_digest text not null,
          operation_token text not null unique
        );
      `);
    });
  }

  async retain(input: unknown): Promise<QualificationCohortArtifactRetainOutcome> {
    const decoded = decodeQualificationCohortArtifactRetainInput(input);
    if (decoded === null) return conflict("invalidInput");
    if (decoded.executionId !== this.ctx.id.name) return conflict("executionMismatch");
    if (!exactKeyForFamily(decoded.executionId, decoded.family, decoded.key)) {
      return conflict("artifactKeyMismatch");
    }
    if (!validMetadata(decoded.metadata)) return conflict("metadataBoundsInvalid");
    if (
      decoded.metadata["osfo-execution-id"] !== decoded.executionId ||
      decoded.metadata["osfo-kind"] !== familyKind[decoded.family]
    ) {
      return conflict("metadataIdentityMismatch");
    }
    if (this.#active) return { _tag: "Busy" };
    this.#active = true;
    try {
      const digest = await bodySha256(decoded.body);
      const metadataDigest = qualificationChecksum(decoded.metadata);
      const requested: ArtifactRow = {
        artifact_key: decoded.key,
        body_sha256: digest,
        family: decoded.family,
        metadata_digest: metadataDigest,
        operation_token: decoded.operationToken,
      };
      const state = this.#state();
      if (state === null) {
        this.ctx.storage.sql.exec(
          "insert into authority_state (singleton, execution_id, protocol_version, lifecycle) values (1, ?, ?, 'OPEN')",
          decoded.executionId,
          decoded.protocolVersion,
        );
      } else if (
        state.execution_id !== decoded.executionId ||
        state.protocol_version !== decoded.protocolVersion
      ) {
        return conflict("authorityIdentityMismatch");
      } else if (state.lifecycle === "FENCED") {
        return { _tag: "Fenced" };
      }

      const reconciled = await this.#reconcilePending();
      if (reconciled === "Conflict") return conflict("pendingIntentConflict");
      const tokenArtifact = this.#artifactByToken(decoded.operationToken);
      if (tokenArtifact !== null) {
        return artifactRowsEqual(tokenArtifact, requested)
          ? complete(tokenArtifact)
          : conflict("operationTokenConflict");
      }
      const existing = this.#artifact(decoded.key);
      if (existing !== null) {
        return artifactRowsEqual(existing, requested)
          ? complete(existing)
          : conflict("immutableArtifactConflict");
      }

      this.ctx.storage.sql.exec(
        "insert into pending_intent (singleton, artifact_key, family, body_sha256, metadata_digest, operation_token) values (1, ?, ?, ?, ?, ?)",
        requested.artifact_key,
        requested.family,
        requested.body_sha256,
        requested.metadata_digest,
        requested.operation_token,
      );
      await this.env.ARTIFACTS.put(decoded.key, decoded.body, {
        customMetadata: decoded.metadata,
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: hexToBytes(digest.slice("sha256:".length)),
      });
      const retained = await this.#readExact(requested);
      if (retained === "Absent") return conflict("artifactWriteUnavailable");
      if (retained === "Conflict") return conflict("artifactReadbackConflict");
      if (!this.#commit(requested)) return conflict("immutableArtifactConflict");
      return complete(requested);
    } finally {
      this.#active = false;
    }
  }

  async fence(input: unknown): Promise<QualificationCohortArtifactFenceOutcome> {
    const decoded = decodeQualificationCohortArtifactFenceInput(input);
    if (decoded === null || decoded.executionId !== this.ctx.id.name) {
      return { _tag: "Conflict", code: "authorityIdentityMismatch" };
    }
    if (this.#active) return { _tag: "Busy" };
    this.#active = true;
    try {
      const state = this.#state();
      if (state === null) return { _tag: "Missing" };
      if (
        state.execution_id !== decoded.executionId ||
        state.protocol_version !== decoded.protocolVersion
      ) {
        return { _tag: "Conflict", code: "authorityIdentityMismatch" };
      }
      const reconciled = await this.#reconcilePending();
      if (reconciled === "Conflict") {
        return { _tag: "Conflict", code: "pendingIntentConflict" };
      }
      this.ctx.storage.sql.exec(
        "update authority_state set lifecycle = 'FENCED' where singleton = 1 and lifecycle = 'OPEN'",
      );
      return { _tag: "Fenced", protocolVersion: qualificationCohortArtifactProtocol };
    } finally {
      this.#active = false;
    }
  }

  #artifact(key: string): ArtifactRow | null {
    return (
      this.ctx.storage.sql
        .exec<ArtifactRow>(
          "select artifact_key, family, body_sha256, metadata_digest, operation_token from artifact_records where artifact_key = ?",
          key,
        )
        .toArray()[0] ?? null
    );
  }

  #artifactByToken(operationToken: string): ArtifactRow | null {
    return (
      this.ctx.storage.sql
        .exec<ArtifactRow>(
          "select artifact_key, family, body_sha256, metadata_digest, operation_token from artifact_records where operation_token = ?",
          operationToken,
        )
        .toArray()[0] ?? null
    );
  }

  #commit(row: ArtifactRow): boolean {
    const tokenArtifact = this.#artifactByToken(row.operation_token);
    if (tokenArtifact !== null && !artifactRowsEqual(tokenArtifact, row)) return false;
    this.ctx.storage.sql.exec(
      "insert into artifact_records (artifact_key, family, body_sha256, metadata_digest, operation_token) values (?, ?, ?, ?, ?) on conflict (artifact_key) do nothing",
      row.artifact_key,
      row.family,
      row.body_sha256,
      row.metadata_digest,
      row.operation_token,
    );
    const committed = this.#artifact(row.artifact_key);
    if (committed === null || !artifactRowsEqual(committed, row)) return false;
    this.ctx.storage.sql.exec("delete from pending_intent where singleton = 1");
    return true;
  }

  async #readExact(row: ArtifactRow): Promise<"Absent" | "Conflict" | "Exact"> {
    const object = await this.env.ARTIFACTS.get(row.artifact_key);
    if (object === null) return "Absent";
    const retainedBodySha256 = await bodySha256(await object.text());
    return retainedBodySha256 === row.body_sha256 &&
      object.checksums.sha256 !== undefined &&
      bytesToHex(new Uint8Array(object.checksums.sha256)) ===
        row.body_sha256.slice("sha256:".length) &&
      qualificationChecksum(object.customMetadata ?? {}) === row.metadata_digest &&
      object.httpMetadata?.contentType === "application/json"
      ? "Exact"
      : "Conflict";
  }

  async #reconcilePending(): Promise<"Absent" | "Conflict" | "Exact" | "None"> {
    const pending =
      this.ctx.storage.sql
        .exec<PendingRow>(
          "select artifact_key, family, body_sha256, metadata_digest, operation_token from pending_intent where singleton = 1",
        )
        .toArray()[0] ?? null;
    if (pending === null) return "None";
    const outcome = await this.#readExact(pending);
    if (outcome === "Exact" && !this.#commit(pending)) return "Conflict";
    if (outcome === "Absent") {
      this.ctx.storage.sql.exec("delete from pending_intent where singleton = 1");
    }
    return outcome;
  }

  #state(): AuthorityStateRow | null {
    return (
      this.ctx.storage.sql
        .exec<AuthorityStateRow>(
          "select execution_id, protocol_version, lifecycle from authority_state where singleton = 1",
        )
        .toArray()[0] ?? null
    );
  }
}

const artifactRowsEqual = (left: ArtifactRow, right: ArtifactRow): boolean =>
  left.artifact_key === right.artifact_key &&
  left.body_sha256 === right.body_sha256 &&
  left.family === right.family &&
  left.metadata_digest === right.metadata_digest &&
  left.operation_token === right.operation_token;

const complete = (row: ArtifactRow): QualificationCohortArtifactRetainOutcome => ({
  _tag: "Complete",
  bodySha256: row.body_sha256,
  key: row.artifact_key,
  metadataDigest: row.metadata_digest,
  protocolVersion: qualificationCohortArtifactProtocol,
});
