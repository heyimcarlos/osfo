/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop, eslint/no-underscore-dangle, osfo/no-unknown-parameters -- Cloudflare owns the Promise-native RPC boundary; sequential batches enforce the connection cap; closed outcomes use _tag. */
import { DurableObject } from "cloudflare:workers";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { qualificationChecksum } from "./qualification/qualification-checksum";
import {
  decodeQualificationCohortArtifactDeletePageInput,
  decodeQualificationCohortArtifactDeleteRootInput,
  decodeQualificationCohortArtifactFenceInput,
  decodeQualificationCohortArtifactInspectInput,
  decodeQualificationCohortArtifactRetainInput,
  decodeQualificationCohortArtifactSealPageInput,
  decodeQualificationCohortArtifactSealRootInput,
  qualificationCohortArtifactPostDeleteSurvivors,
  qualificationCohortArtifactProtocol,
  type QualificationCohortArtifactDeleteOutcome,
  type QualificationCohortArtifactDeletePageInput,
  type QualificationCohortArtifactDeleteRootInput,
  type QualificationCohortArtifactFamily,
  type QualificationCohortArtifactFenceOutcome,
  type QualificationCohortArtifactInspection,
  type QualificationCohortArtifactRetainOutcome,
  type QualificationCohortArtifactSealPageOutcome,
  type QualificationCohortArtifactSealRootOutcome,
} from "./qualification/cohort-artifact-authority-contract";

interface AuthorityEnv {
  readonly ARTIFACTS: R2Bucket;
}

interface AuthorityStateRow extends Record<string, SqlStorageValue> {
  readonly execution_id: string;
  readonly lifecycle: "FENCED" | "OPEN" | "SCRUBBED";
  readonly protocol_version: string;
  readonly root_checksum: string | null;
}

interface ArtifactRow extends Record<string, SqlStorageValue> {
  readonly artifact_key: string;
  readonly body_sha256: string;
  readonly family: QualificationCohortArtifactFamily;
  readonly metadata_digest: string;
  readonly operation_token: string;
}

interface DeleteIntentRow extends Record<string, SqlStorageValue> {
  readonly artifact_records_checksum: string;
  readonly expected_artifact_count: number;
  readonly expected_artifacts_checksum: string;
  readonly expected_page_count: number | null;
  readonly final_page_checksum: string | null;
  readonly operation_id: string;
  readonly page_index: number | null;
  readonly phase: "ARMED" | "PROVEN";
  readonly plan: "adventurer" | "free" | null;
  readonly position: number | null;
  readonly previous_page_checksum: string | null;
  readonly proof_checksum: string | null;
  readonly scope: "page" | "root";
}

interface SealedPageRow extends Record<string, SqlStorageValue> {
  readonly artifact_records_checksum: string;
  readonly expected_artifact_count: number;
  readonly expected_artifacts_checksum: string;
  readonly page_checksum: string;
  readonly page_index: number;
  readonly plan: "adventurer" | "free";
  readonly position: number;
  readonly previous_page_checksum: string;
  readonly proof_checksum: string;
  readonly receipt_checksum: string;
}

type PendingRow = ArtifactRow;
type DeleteInput =
  | QualificationCohortArtifactDeletePageInput
  | QualificationCohortArtifactDeleteRootInput;

const familyKind = {
  finalizePage: "qualification-cohort-finalize-page-v1",
  inventoryReceipt: "qualification-cohort-inventory-v1",
  manifest: "qualification-cohort-v1",
  participantGrant: "qualification-participant-grant-v1",
  provisionPage: "qualification-cohort-provision-page-v1",
} as const satisfies Record<QualificationCohortArtifactFamily, string>;

const migrations = [
  {
    statements: `
      create table if not exists authority_state (
        singleton integer primary key check (singleton = 1), execution_id text not null,
        protocol_version text not null, lifecycle text not null check (lifecycle in ('OPEN', 'FENCED'))
      );
      create table if not exists artifact_records (
        artifact_key text primary key, family text not null, body_sha256 text not null,
        metadata_digest text not null, operation_token text not null unique
      );
      create table if not exists pending_intent (
        singleton integer primary key check (singleton = 1), artifact_key text not null,
        family text not null, body_sha256 text not null, metadata_digest text not null,
        operation_token text not null unique
      );`,
    version: 1,
  },
  {
    statements: `
      create table authority_state_v2 (
        singleton integer primary key check (singleton = 1), execution_id text not null,
        protocol_version text not null,
        lifecycle text not null check (lifecycle in ('OPEN', 'FENCED', 'SCRUBBED')),
        root_checksum text,
        check ((lifecycle = 'SCRUBBED' and root_checksum is not null)
          or (lifecycle <> 'SCRUBBED' and root_checksum is null))
      );
      insert into authority_state_v2 (singleton, execution_id, protocol_version, lifecycle, root_checksum)
        select singleton, execution_id, protocol_version, lifecycle, null from authority_state;
      drop table authority_state;
      alter table authority_state_v2 rename to authority_state;
      create table delete_intent (
        singleton integer primary key check (singleton = 1),
        scope text not null check (scope in ('page', 'root')), operation_id text not null,
        phase text not null check (phase in ('ARMED', 'PROVEN')),
        expected_artifact_count integer not null, expected_artifacts_checksum text not null,
        artifact_records_checksum text not null, proof_checksum text, plan text, page_index integer,
        position integer, previous_page_checksum text, expected_page_count integer,
        final_page_checksum text,
        check ((phase = 'PROVEN' and proof_checksum is not null)
          or (phase = 'ARMED' and proof_checksum is null))
      );
      create table sealed_page_receipts (
        position integer primary key, plan text not null check (plan in ('free', 'adventurer')),
        page_index integer not null, previous_page_checksum text not null, page_checksum text not null,
        proof_checksum text not null, expected_artifact_count integer not null,
        expected_artifacts_checksum text not null, artifact_records_checksum text not null,
        receipt_checksum text not null unique,
        unique (plan, page_index), unique (page_checksum), unique (proof_checksum)
      );`,
    version: 2,
  },
] as const;

/** Constructor-owned SQL migration runner. Production invokes it only during constructor initialization. */
export const migrateQualificationCohortArtifactAuthority = (
  storage: DurableObjectStorage,
): void => {
  const { sql } = storage;
  sql.exec(`create table if not exists _sql_schema_migrations (
    version integer primary key, applied_at text not null default current_timestamp
  )`);
  const applied = new Set(
    sql
      .exec<{ version: number }>("select version from _sql_schema_migrations order by version")
      .toArray()
      .map(({ version }) => version),
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    storage.transactionSync(() => {
      sql.exec(migration.statements);
      const marker = sql.exec(
        "insert into _sql_schema_migrations (version) values (?)",
        migration.version,
      );
      if (marker.rowsWritten !== 1) {
        throw new Error(
          `Qualification cohort artifact migration ${migration.version} was not retained`,
        );
      }
    });
  }
};

const bodySha256 = async (body: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `sha256:${bytesToHex(new Uint8Array(bytes))}`;
};

const prefixFor = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/cohort/`;

const familyForKey = (
  executionId: string,
  key: string,
): QualificationCohortArtifactFamily | null => {
  const prefix = prefixFor(executionId);
  if (!key.startsWith(prefix)) return null;
  const suffix = key.slice(prefix.length);
  if (suffix === "manifest.json") return "manifest";
  if (suffix === "inventory-receipt.json") return "inventoryReceipt";
  if (/^provision-pages\/[0-9]{8}\.json$/u.test(suffix)) return "provisionPage";
  if (/^grants\/(?:free|adventurer)\/[0-9]{8}\.json$/u.test(suffix)) {
    return "participantGrant";
  }
  return /^finalize-pages\/(?:free|adventurer)\/[0-9]{8}\.json$/u.test(suffix)
    ? "finalizePage"
    : null;
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

export const qualificationCohortArtifactMapFive = async <A, B>(
  items: ReadonlyArray<A>,
  evaluate: (item: A) => Promise<B>,
): Promise<Array<B>> => {
  const results: Array<B> = [];
  for (let offset = 0; offset < items.length; offset += 5) {
    results.push(...(await Promise.all(items.slice(offset, offset + 5).map(evaluate))));
  }
  return results;
};

/** Atomically replace all recoverable deletion authority with the content-free SCRUBBED tombstone. */
export const sealQualificationCohortArtifactAuthorityRoot = (
  storage: DurableObjectStorage,
  rootChecksum: string,
): void => {
  storage.transactionSync(() => {
    const transitioned = storage.sql.exec(
      "update authority_state set lifecycle = 'SCRUBBED', root_checksum = ? where singleton = 1 and lifecycle = 'FENCED'",
      rootChecksum,
    );
    if (transitioned.rowsWritten !== 1) {
      throw new Error("Qualification cohort artifact authority did not enter SCRUBBED");
    }
    storage.sql.exec("delete from artifact_records");
    storage.sql.exec("delete from pending_intent");
    storage.sql.exec("delete from delete_intent");
    storage.sql.exec("delete from sealed_page_receipts");
  });
};

/** Exclusive, execution-scoped mutation and deletion authority for disposable cohort R2 artifacts. */
export class QualificationCohortArtifactAuthority extends DurableObject<AuthorityEnv> {
  #active = false;

  constructor(ctx: DurableObjectState, env: AuthorityEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateQualificationCohortArtifactAuthority(this.ctx.storage);
    });
  }

  async retain(input: unknown): Promise<QualificationCohortArtifactRetainOutcome> {
    const decoded = decodeQualificationCohortArtifactRetainInput(input);
    if (decoded === null) return conflict("invalidInput");
    if (decoded.executionId !== this.ctx.id.name) return conflict("executionMismatch");
    if (familyForKey(decoded.executionId, decoded.key) !== decoded.family) {
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
      const requested: ArtifactRow = {
        artifact_key: decoded.key,
        body_sha256: await bodySha256(decoded.body),
        family: decoded.family,
        metadata_digest: qualificationChecksum(decoded.metadata),
        operation_token: decoded.operationToken,
      };
      const state = this.#state();
      if (state === null) {
        this.ctx.storage.sql.exec(
          "insert into authority_state values (1, ?, ?, 'OPEN', null)",
          decoded.executionId,
          decoded.protocolVersion,
        );
      } else if (!stateMatches(state, decoded.executionId, decoded.protocolVersion)) {
        return conflict("authorityIdentityMismatch");
      } else if (state.lifecycle !== "OPEN") {
        return { _tag: "Fenced" };
      }
      const reconciled = await this.#reconcilePendingWrite();
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
        "insert into pending_intent values (1, ?, ?, ?, ?, ?)",
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
        sha256: hexToBytes(requested.body_sha256.slice("sha256:".length)),
      });
      const retained = await this.#readExactBody(requested);
      if (retained === "Absent") return conflict("artifactWriteUnavailable");
      if (retained === "Conflict") return conflict("artifactReadbackConflict");
      if (!this.#commitWrite(requested)) return conflict("immutableArtifactConflict");
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
      if (!stateMatches(state, decoded.executionId, decoded.protocolVersion)) {
        return { _tag: "Conflict", code: "authorityIdentityMismatch" };
      }
      if (state.lifecycle === "SCRUBBED") {
        return { _tag: "Conflict", code: "authorityAlreadyScrubbed" };
      }
      if ((await this.#reconcilePendingWrite()) === "Conflict") {
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

  async deletePage(input: unknown): Promise<QualificationCohortArtifactDeleteOutcome> {
    const decoded = decodeQualificationCohortArtifactDeletePageInput(input);
    return decoded === null
      ? { _tag: "Conflict", code: "invalidInput" }
      : await this.#delete("page", decoded);
  }

  async deleteRoot(input: unknown): Promise<QualificationCohortArtifactDeleteOutcome> {
    const decoded = decodeQualificationCohortArtifactDeleteRootInput(input);
    return decoded === null
      ? { _tag: "Conflict", code: "invalidInput" }
      : await this.#delete("root", decoded);
  }

  async sealPage(input: unknown): Promise<QualificationCohortArtifactSealPageOutcome> {
    const decoded = decodeQualificationCohortArtifactSealPageInput(input);
    if (decoded === null) return { _tag: "Conflict", code: "invalidInput" };
    if (decoded.executionId !== this.ctx.id.name) {
      return { _tag: "Conflict", code: "executionMismatch" };
    }
    if (this.#active) return { _tag: "Busy" };
    if (!validExpectedKeys(decoded.executionId, decoded.expectedArtifactKeys)) {
      return { _tag: "Conflict", code: "artifactKeyMismatch" };
    }
    if (
      qualificationChecksum({ expectedArtifactIds: [...decoded.expectedArtifactKeys] }) !==
      decoded.expectedArtifactsChecksum
    ) {
      return { _tag: "Conflict", code: "expectedArtifactsChecksumMismatch" };
    }
    const state = this.#state();
    if (state?.lifecycle === "SCRUBBED") return this.#replaySealedPage(decoded);
    if (state?.lifecycle !== "FENCED") {
      return { _tag: "Missing", code: "authorityNotFenced" };
    }
    const intent = this.#deleteIntent();
    if (
      intent === null ||
      intent.scope !== "page" ||
      intent.phase !== "PROVEN" ||
      intent.proof_checksum !== decoded.proofChecksum ||
      intent.expected_artifacts_checksum !== decoded.expectedArtifactsChecksum ||
      intent.plan !== decoded.plan ||
      intent.page_index !== decoded.pageIndex ||
      intent.position !== decoded.position ||
      intent.previous_page_checksum !== decoded.previousPageChecksum
    ) {
      return this.#replaySealedPage(decoded);
    }
    const sealedWithoutReceipt = {
      artifact_records_checksum: intent.artifact_records_checksum,
      expected_artifact_count: intent.expected_artifact_count,
      expected_artifacts_checksum: intent.expected_artifacts_checksum,
      page_checksum: decoded.pageChecksum,
      page_index: decoded.pageIndex,
      plan: decoded.plan,
      position: decoded.position,
      previous_page_checksum: decoded.previousPageChecksum,
      proof_checksum: decoded.proofChecksum,
    };
    const sealed: SealedPageRow = {
      ...sealedWithoutReceipt,
      receipt_checksum: sealedPageReceiptChecksum(sealedWithoutReceipt),
    };
    const existing = this.#sealedPage(decoded.position);
    if (existing !== null && !sealedPageRowsEqual(existing, sealed)) {
      return { _tag: "Conflict", code: "sealedPageConflict" };
    }
    if (existing === null) {
      this.ctx.storage.sql.exec(
        `insert into sealed_page_receipts
          (position, plan, page_index, previous_page_checksum, page_checksum, proof_checksum,
           expected_artifact_count, expected_artifacts_checksum, artifact_records_checksum,
           receipt_checksum)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sealed.position,
        sealed.plan,
        sealed.page_index,
        sealed.previous_page_checksum,
        sealed.page_checksum,
        sealed.proof_checksum,
        sealed.expected_artifact_count,
        sealed.expected_artifacts_checksum,
        sealed.artifact_records_checksum,
        sealed.receipt_checksum,
      );
    }
    deleteArtifactRecords(this.ctx.storage.sql, decoded.expectedArtifactKeys);
    this.ctx.storage.sql.exec("delete from delete_intent where singleton = 1");
    return sealedOutcome(sealed);
  }

  async sealRoot(input: unknown): Promise<QualificationCohortArtifactSealRootOutcome> {
    const decoded = decodeQualificationCohortArtifactSealRootInput(input);
    if (decoded === null || decoded.executionId !== this.ctx.id.name) {
      return { _tag: "Conflict", code: "invalidInput" };
    }
    if (this.#active) return { _tag: "Busy" };
    const state = this.#state();
    if (state?.lifecycle === "SCRUBBED") {
      return state.root_checksum === decoded.rootChecksum
        ? { _tag: "Scrubbed", rootChecksum: decoded.rootChecksum }
        : { _tag: "Conflict", code: "rootChecksumConflict" };
    }
    const intent = this.#deleteIntent();
    if (
      state?.lifecycle !== "FENCED" ||
      intent === null ||
      intent.scope !== "root" ||
      intent.phase !== "PROVEN" ||
      intent.proof_checksum !== decoded.proofChecksum
    ) {
      return { _tag: "Missing", code: "rootAbsenceProofMissing" };
    }
    sealQualificationCohortArtifactAuthorityRoot(this.ctx.storage, decoded.rootChecksum);
    return { _tag: "Scrubbed", rootChecksum: decoded.rootChecksum };
  }

  async inspect(input: unknown): Promise<QualificationCohortArtifactInspection> {
    const decoded = decodeQualificationCohortArtifactInspectInput(input);
    if (decoded === null || decoded.executionId !== this.ctx.id.name) {
      return { _tag: "Conflict", code: "invalidInput" };
    }
    const state = this.#state();
    if (state === null) return { _tag: "Missing" };
    if (!stateMatches(state, decoded.executionId, decoded.protocolVersion)) {
      return { _tag: "Conflict", code: "authorityIdentityMismatch" };
    }
    if (state.lifecycle === "SCRUBBED") {
      return state.root_checksum === null
        ? { _tag: "Conflict", code: "scrubbedRootChecksumMissing" }
        : { _tag: "Scrubbed", rootChecksum: state.root_checksum };
    }
    const intent = this.#deleteIntent();
    return {
      _tag: "Present",
      artifactRecordCount: countRows(this.ctx.storage.sql, "artifact_records"),
      lifecycle: state.lifecycle,
      pendingDeleteScope: intent?.phase === "ARMED" ? intent.scope : null,
      provenDeleteScope: intent?.phase === "PROVEN" ? intent.scope : null,
      sealedPageCount: countRows(this.ctx.storage.sql, "sealed_page_receipts"),
    };
  }

  async #delete(
    scope: "page" | "root",
    input: DeleteInput,
  ): Promise<QualificationCohortArtifactDeleteOutcome> {
    if (input.executionId !== this.ctx.id.name) {
      return { _tag: "Conflict", code: "executionMismatch" };
    }
    if (this.#active) return { _tag: "Busy" };
    this.#active = true;
    try {
      const validated = this.#validateDeleteInput(scope, input);
      if (validated._tag !== "Ready") return validated;
      const existing = this.#deleteIntent();
      if (existing !== null && !deleteIntentsEqual(existing, validated.intent)) {
        return { _tag: "Conflict", code: "deleteIntentConflict" };
      }
      if (existing === null) insertDeleteIntent(this.ctx.storage.sql, validated.intent);
      const current = existing ?? validated.intent;
      if (current.phase === "PROVEN") return proven(current);
      const preflight = await this.#readExactHeads(validated.records);
      if (preflight._tag !== "Exact") return preflight;
      let deleteThrew = false;
      if (preflight.presentKeys.length > 0) {
        try {
          await this.env.ARTIFACTS.delete(preflight.presentKeys);
        } catch {
          deleteThrew = true;
        }
      }
      const postflight = await this.#readExactHeads(validated.records);
      if (postflight._tag !== "Exact") return postflight;
      const survivorOutcome = qualificationCohortArtifactPostDeleteSurvivors(
        deleteThrew,
        current.operation_id,
        postflight.presentKeys,
      );
      if (survivorOutcome !== null) return survivorOutcome;
      const proofChecksum = qualificationChecksum({
        artifactRecordsChecksum: current.artifact_records_checksum,
        expectedArtifactCount: current.expected_artifact_count,
        expectedArtifactsChecksum: current.expected_artifacts_checksum,
        operationId: current.operation_id,
        scope: current.scope,
        state: "PROVEN",
      });
      this.ctx.storage.sql.exec(
        "update delete_intent set phase = 'PROVEN', proof_checksum = ? where singleton = 1 and operation_id = ? and phase = 'ARMED'",
        proofChecksum,
        current.operation_id,
      );
      const persisted = this.#deleteIntent();
      return persisted === null || persisted.phase !== "PROVEN"
        ? { _tag: "Conflict", code: "absenceProofPersistenceConflict" }
        : proven(persisted);
    } finally {
      this.#active = false;
    }
  }

  #validateDeleteInput(
    scope: "page" | "root",
    input: DeleteInput,
  ):
    | {
        readonly _tag: "Ready";
        readonly intent: DeleteIntentRow;
        readonly records: Array<ArtifactRow>;
      }
    | { readonly _tag: "Conflict"; readonly code: string }
    | { readonly _tag: "Missing"; readonly code: string } {
    const state = this.#state();
    if (state === null || state.lifecycle === "OPEN") {
      return { _tag: "Missing", code: "authorityNotFenced" };
    }
    if (state.lifecycle === "SCRUBBED") {
      return { _tag: "Conflict", code: "authorityAlreadyScrubbed" };
    }
    if (!stateMatches(state, input.executionId, input.protocolVersion)) {
      return { _tag: "Conflict", code: "authorityIdentityMismatch" };
    }
    if (!validExpectedKeys(input.executionId, input.expectedArtifactKeys)) {
      return { _tag: "Conflict", code: "artifactKeyMismatch" };
    }
    if (
      qualificationChecksum({ expectedArtifactIds: [...input.expectedArtifactKeys] }) !==
      input.expectedArtifactsChecksum
    ) {
      return { _tag: "Conflict", code: "expectedArtifactsChecksumMismatch" };
    }
    const page = "pageIndex" in input ? input : null;
    const root = "expectedPageCount" in input ? input : null;
    if ((scope === "page" && page === null) || (scope === "root" && root === null)) {
      return { _tag: "Conflict", code: "deleteScopeMismatch" };
    }
    if (root !== null) {
      if (!rootKeysMatchIdentity(root.executionId, root.expectedArtifactKeys)) {
        return { _tag: "Conflict", code: "rootArtifactIdentityMismatch" };
      }
      const pages = this.#rootPagesAuthority(root.expectedPageCount, root.finalPageChecksum);
      if (pages !== "Exact") {
        return pages === "Missing"
          ? { _tag: "Missing", code: "sealedPageChainIncomplete" }
          : { _tag: "Conflict", code: "sealedPageChainConflict" };
      }
    } else if (page !== null) {
      if (!pageKeysMatchIdentity(page)) {
        return { _tag: "Conflict", code: "pageArtifactIdentityMismatch" };
      }
      const predecessor = this.#pagePredecessorAuthority(page.position, page.previousPageChecksum);
      if (predecessor !== "Exact") {
        return predecessor === "Missing"
          ? { _tag: "Missing", code: "sealedPagePredecessorMissing" }
          : { _tag: "Conflict", code: "sealedPagePredecessorConflict" };
      }
    }
    const records: Array<ArtifactRow> = [];
    for (const key of input.expectedArtifactKeys) {
      const row = this.#artifact(key);
      if (row === null) return { _tag: "Missing", code: "artifactAuthorityRecordMissing" };
      if (row.family !== familyForKey(input.executionId, key)) {
        return { _tag: "Conflict", code: "artifactAuthorityRecordMismatch" };
      }
      records.push(row);
    }
    if (scope === "root" && this.#artifacts().length !== records.length) {
      return { _tag: "Conflict", code: "unexpectedArtifactAuthorityRecord" };
    }
    const artifactRecordsChecksum = qualificationChecksum({
      records: records.map(recordIdentity),
    });
    const operationId =
      page !== null
        ? qualificationChecksum({
            artifactRecordsChecksum,
            executionId: input.executionId,
            expectedArtifactCount: records.length,
            expectedArtifactsChecksum: input.expectedArtifactsChecksum,
            pageIndex: page.pageIndex,
            plan: page.plan,
            position: page.position,
            previousPageChecksum: page.previousPageChecksum,
            scope,
          })
        : qualificationChecksum({
            artifactRecordsChecksum,
            executionId: input.executionId,
            expectedArtifactCount: records.length,
            expectedArtifactsChecksum: input.expectedArtifactsChecksum,
            expectedPageCount: root?.expectedPageCount,
            finalPageChecksum: root?.finalPageChecksum,
            scope,
          });
    const shared = {
      artifact_records_checksum: artifactRecordsChecksum,
      expected_artifact_count: records.length,
      expected_artifacts_checksum: input.expectedArtifactsChecksum,
      operation_id: operationId,
      phase: "ARMED" as const,
      proof_checksum: null,
      scope,
    };
    const intent: DeleteIntentRow =
      page !== null
        ? {
            ...shared,
            expected_page_count: null,
            final_page_checksum: null,
            page_index: page.pageIndex,
            plan: page.plan,
            position: page.position,
            previous_page_checksum: page.previousPageChecksum,
          }
        : {
            ...shared,
            expected_page_count: root?.expectedPageCount ?? null,
            final_page_checksum: root?.finalPageChecksum ?? null,
            page_index: null,
            plan: null,
            position: null,
            previous_page_checksum: null,
          };
    return { _tag: "Ready", intent, records };
  }

  async #readExactHeads(
    records: ReadonlyArray<ArtifactRow>,
  ): Promise<
    | { readonly _tag: "Exact"; readonly presentKeys: Array<string> }
    | { readonly _tag: "Conflict"; readonly code: string }
  > {
    const presentKeys: Array<string> = [];
    const outcomes = await qualificationCohortArtifactMapFive(records, async (record) => ({
      object: await this.env.ARTIFACTS.head(record.artifact_key),
      record,
    }));
    for (const { object, record } of outcomes) {
      if (object === null) continue;
      if (!headMatches(object, record)) {
        return { _tag: "Conflict", code: "retainedArtifactMismatch" };
      }
      presentKeys.push(record.artifact_key);
    }
    return { _tag: "Exact", presentKeys };
  }

  #pagePredecessorAuthority(
    position: number,
    previousPageChecksum: string,
  ): "Conflict" | "Exact" | "Missing" {
    if (position === 0) {
      return previousPageChecksum !== "NONE" || this.#sealedPage(0) !== null ? "Conflict" : "Exact";
    }
    const previous = this.#sealedPage(position - 1);
    if (previous === null) return "Missing";
    return previous.page_checksum === previousPageChecksum &&
      previous.receipt_checksum === sealedPageReceiptChecksum(previous)
      ? "Exact"
      : "Conflict";
  }

  #rootPagesAuthority(
    expectedPageCount: number,
    finalPageChecksum: string,
  ): "Conflict" | "Exact" | "Missing" {
    const pages = this.ctx.storage.sql
      .exec<SealedPageRow>(
        `select position, plan, page_index, previous_page_checksum, page_checksum, proof_checksum,
          expected_artifact_count, expected_artifacts_checksum, artifact_records_checksum,
          receipt_checksum
         from sealed_page_receipts order by position`,
      )
      .toArray();
    if (pages.length < expectedPageCount) return "Missing";
    if (pages.length > expectedPageCount) return "Conflict";
    let previous = "NONE";
    for (const [position, page] of pages.entries()) {
      if (
        page.position !== position ||
        page.previous_page_checksum !== previous ||
        page.receipt_checksum !== sealedPageReceiptChecksum(page)
      ) {
        return "Conflict";
      }
      previous = page.page_checksum;
    }
    return previous === finalPageChecksum ? "Exact" : "Conflict";
  }

  #replaySealedPage(
    input: NonNullable<ReturnType<typeof decodeQualificationCohortArtifactSealPageInput>>,
  ): QualificationCohortArtifactSealPageOutcome {
    const existing = this.#sealedPage(input.position);
    return existing !== null &&
      existing.page_checksum === input.pageChecksum &&
      existing.proof_checksum === input.proofChecksum &&
      existing.plan === input.plan &&
      existing.page_index === input.pageIndex &&
      existing.previous_page_checksum === input.previousPageChecksum &&
      existing.expected_artifacts_checksum === input.expectedArtifactsChecksum &&
      existing.receipt_checksum === sealedPageReceiptChecksum(existing)
      ? sealedOutcome(existing)
      : { _tag: "Missing", code: "pageAbsenceProofMissing" };
  }

  #sealedPage(position: number): SealedPageRow | null {
    return (
      this.ctx.storage.sql
        .exec<SealedPageRow>(
          `select position, plan, page_index, previous_page_checksum, page_checksum, proof_checksum,
            expected_artifact_count, expected_artifacts_checksum, artifact_records_checksum,
            receipt_checksum
           from sealed_page_receipts where position = ?`,
          position,
        )
        .toArray()[0] ?? null
    );
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

  #artifacts(): Array<ArtifactRow> {
    return this.ctx.storage.sql
      .exec<ArtifactRow>(
        "select artifact_key, family, body_sha256, metadata_digest, operation_token from artifact_records order by artifact_key",
      )
      .toArray();
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

  #commitWrite(row: ArtifactRow): boolean {
    const tokenArtifact = this.#artifactByToken(row.operation_token);
    if (tokenArtifact !== null && !artifactRowsEqual(tokenArtifact, row)) return false;
    this.ctx.storage.sql.exec(
      "insert into artifact_records values (?, ?, ?, ?, ?) on conflict (artifact_key) do nothing",
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

  async #readExactBody(row: ArtifactRow): Promise<"Absent" | "Conflict" | "Exact"> {
    const object = await this.env.ARTIFACTS.get(row.artifact_key);
    if (object === null) return "Absent";
    return (await bodySha256(await object.text())) === row.body_sha256 && headMatches(object, row)
      ? "Exact"
      : "Conflict";
  }

  async #reconcilePendingWrite(): Promise<"Absent" | "Conflict" | "Exact" | "None"> {
    const pending =
      this.ctx.storage.sql
        .exec<PendingRow>(
          "select artifact_key, family, body_sha256, metadata_digest, operation_token from pending_intent where singleton = 1",
        )
        .toArray()[0] ?? null;
    if (pending === null) return "None";
    const outcome = await this.#readExactBody(pending);
    if (outcome === "Exact" && !this.#commitWrite(pending)) return "Conflict";
    if (outcome === "Absent") this.ctx.storage.sql.exec("delete from pending_intent");
    return outcome;
  }

  #deleteIntent(): DeleteIntentRow | null {
    return (
      this.ctx.storage.sql.exec<DeleteIntentRow>("select * from delete_intent").toArray()[0] ?? null
    );
  }

  #state(): AuthorityStateRow | null {
    return (
      this.ctx.storage.sql
        .exec<AuthorityStateRow>(
          "select execution_id, protocol_version, lifecycle, root_checksum from authority_state where singleton = 1",
        )
        .toArray()[0] ?? null
    );
  }
}

const validExpectedKeys = (executionId: string, keys: ReadonlyArray<string>): boolean =>
  new Set(keys).size === keys.length &&
  keys.every((key, index) => {
    const previous = index === 0 ? null : keys[index - 1];
    return (
      familyForKey(executionId, key) !== null &&
      (previous === null || (previous !== undefined && previous < key))
    );
  });

const pageKeysMatchIdentity = (input: QualificationCohortArtifactDeletePageInput): boolean => {
  const prefix = prefixFor(input.executionId);
  const expectedFinalize = `${prefix}finalize-pages/${input.plan}/${String(input.pageIndex).padStart(8, "0")}.json`;
  return (
    input.expectedArtifactKeys.includes(expectedFinalize) &&
    input.expectedArtifactKeys.every(
      (key) => !key.includes("/grants/") || key.startsWith(`${prefix}grants/${input.plan}/`),
    )
  );
};

const rootKeysMatchIdentity = (executionId: string, keys: ReadonlyArray<string>): boolean => {
  const prefix = prefixFor(executionId);
  return (
    keys.length === 2 &&
    keys[0] === `${prefix}inventory-receipt.json` &&
    keys[1] === `${prefix}manifest.json`
  );
};

const stateMatches = (state: AuthorityStateRow, executionId: string, protocolVersion: string) =>
  state.execution_id === executionId && state.protocol_version === protocolVersion;

const artifactRowsEqual = (left: ArtifactRow, right: ArtifactRow): boolean =>
  left.artifact_key === right.artifact_key &&
  left.body_sha256 === right.body_sha256 &&
  left.family === right.family &&
  left.metadata_digest === right.metadata_digest &&
  left.operation_token === right.operation_token;

const recordIdentity = (record: ArtifactRow) => ({
  artifactKey: record.artifact_key,
  bodySha256: record.body_sha256,
  family: record.family,
  metadataDigest: record.metadata_digest,
  operationToken: record.operation_token,
});

const deleteIntentsEqual = (left: DeleteIntentRow, right: DeleteIntentRow): boolean =>
  left.scope === right.scope &&
  left.operation_id === right.operation_id &&
  left.expected_artifact_count === right.expected_artifact_count &&
  left.expected_artifacts_checksum === right.expected_artifacts_checksum &&
  left.artifact_records_checksum === right.artifact_records_checksum &&
  left.plan === right.plan &&
  left.page_index === right.page_index &&
  left.position === right.position &&
  left.previous_page_checksum === right.previous_page_checksum &&
  left.expected_page_count === right.expected_page_count &&
  left.final_page_checksum === right.final_page_checksum;

const sealedPageRowsEqual = (left: SealedPageRow, right: SealedPageRow): boolean =>
  left.position === right.position &&
  left.plan === right.plan &&
  left.page_index === right.page_index &&
  left.previous_page_checksum === right.previous_page_checksum &&
  left.page_checksum === right.page_checksum &&
  left.proof_checksum === right.proof_checksum &&
  left.expected_artifact_count === right.expected_artifact_count &&
  left.expected_artifacts_checksum === right.expected_artifacts_checksum &&
  left.artifact_records_checksum === right.artifact_records_checksum &&
  left.receipt_checksum === right.receipt_checksum;

const sealedPageReceiptChecksum = (
  row: Omit<SealedPageRow, "receipt_checksum"> | SealedPageRow,
): string =>
  qualificationChecksum({
    artifactRecordsChecksum: row.artifact_records_checksum,
    expectedArtifactCount: row.expected_artifact_count,
    expectedArtifactsChecksum: row.expected_artifacts_checksum,
    pageChecksum: row.page_checksum,
    pageIndex: row.page_index,
    plan: row.plan,
    position: row.position,
    previousPageChecksum: row.previous_page_checksum,
    proofChecksum: row.proof_checksum,
  });

const insertDeleteIntent = (sql: SqlStorage, intent: DeleteIntentRow): void => {
  sql.exec(
    `insert into delete_intent
      (singleton, scope, operation_id, phase, expected_artifact_count,
       expected_artifacts_checksum, artifact_records_checksum, proof_checksum, plan, page_index,
       position, previous_page_checksum, expected_page_count, final_page_checksum)
     values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    intent.scope,
    intent.operation_id,
    intent.phase,
    intent.expected_artifact_count,
    intent.expected_artifacts_checksum,
    intent.artifact_records_checksum,
    intent.proof_checksum,
    intent.plan,
    intent.page_index,
    intent.position,
    intent.previous_page_checksum,
    intent.expected_page_count,
    intent.final_page_checksum,
  );
};

const deleteArtifactRecords = (sql: SqlStorage, keys: ReadonlyArray<string>): void => {
  const placeholders = keys.map(() => "?").join(", ");
  sql.exec(`delete from artifact_records where artifact_key in (${placeholders})`, ...keys);
};

const countRows = (sql: SqlStorage, table: "artifact_records" | "sealed_page_receipts"): number =>
  sql.exec<{ count: number }>(`select count(*) as count from ${table}`).one().count;

const headMatches = (object: R2Object, row: ArtifactRow): boolean =>
  object.checksums.sha256 !== undefined &&
  `sha256:${bytesToHex(new Uint8Array(object.checksums.sha256))}` === row.body_sha256 &&
  qualificationChecksum(object.customMetadata ?? {}) === row.metadata_digest &&
  object.httpMetadata?.contentType === "application/json";

const proven = (row: DeleteIntentRow): QualificationCohortArtifactDeleteOutcome =>
  row.proof_checksum === null
    ? { _tag: "Conflict", code: "absenceProofMissing" }
    : {
        _tag: "Proven",
        artifactRecordsChecksum: row.artifact_records_checksum,
        expectedArtifactCount: row.expected_artifact_count,
        expectedArtifactsChecksum: row.expected_artifacts_checksum,
        operationId: row.operation_id,
        proofChecksum: row.proof_checksum,
        scope: row.scope,
      };

const sealedOutcome = (row: SealedPageRow): QualificationCohortArtifactSealPageOutcome => ({
  _tag: "Sealed",
  pageChecksum: row.page_checksum,
  position: row.position,
  proofChecksum: row.proof_checksum,
});

const conflict = (code: string): QualificationCohortArtifactRetainOutcome => ({
  _tag: "Conflict",
  code,
});

const complete = (row: ArtifactRow): QualificationCohortArtifactRetainOutcome => ({
  _tag: "Complete",
  bodySha256: row.body_sha256,
  key: row.artifact_key,
  metadataDigest: row.metadata_digest,
  protocolVersion: qualificationCohortArtifactProtocol,
});
