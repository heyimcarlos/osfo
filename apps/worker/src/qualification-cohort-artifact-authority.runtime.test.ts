/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop, eslint/no-underscore-dangle -- This suite drives sequential Cloudflare RPC/R2 state transitions and asserts closed _tag outcomes. */
import { env, runInDurableObject } from "cloudflare:test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, it } from "vitest";

import type { QualificationCohortArtifactAuthority } from "./qualification-cohort-artifact-authority";
import { qualificationChecksum } from "./qualification/qualification-checksum";

interface TestEnv {
  readonly ARTIFACTS: R2Bucket;
  readonly QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST: DurableObjectNamespace<QualificationCohortArtifactAuthority>;
}

// @ts-expect-error The focused runtime config owns this exact test-only generated binding.
const runtimeEnv: TestEnv = env;
const executionId = "exclusive-writer-runtime";
const key = `qualification/executions/${executionId}/cohort/manifest.json`;
const input = {
  body: '{"cohort":"exact"}',
  executionId,
  family: "manifest" as const,
  key,
  metadata: {
    "osfo-cohort-id": "cohort-exclusive-writer",
    "osfo-execution-id": executionId,
    "osfo-kind": "qualification-cohort-v1",
  },
  operationToken: "manifest-operation-v1",
  protocolVersion: "qualification-cohort-artifacts-v1" as const,
};

it("retains one exact cohort artifact and rejects every write after the durable fence", async () => {
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(executionId);
  await runtimeEnv.ARTIFACTS.delete(key);

  const retained = await stub.retain(input);
  expect(retained._tag).toBe("Complete");
  expect(await stub.retain(input)).toEqual(retained);
  await expect((await runtimeEnv.ARTIFACTS.get(key))?.text()).resolves.toBe(input.body);

  expect(await stub.fence({ executionId, protocolVersion: input.protocolVersion })).toEqual({
    _tag: "Fenced",
    protocolVersion: input.protocolVersion,
  });
  expect(
    await stub.retain({
      ...input,
      body: '{"cohort":"late"}',
      operationToken: "manifest-operation-late",
    }),
  ).toEqual({ _tag: "Fenced" });

  await runInDurableObject(stub, async (_instance, state) => {
    const serialized = state.storage.sql
      .exec<Record<string, string | number | null>>(
        "select * from authority_state left join artifact_records on 1 = 1",
      )
      .toArray();
    expect(JSON.stringify(serialized)).not.toContain(input.body);
    expect(JSON.stringify(serialized)).not.toContain(input.metadata["osfo-cohort-id"]);
  });
});

it("owns every canonical cohort artifact family under one execution", async () => {
  const familyExecutionId = `${executionId}-families`;
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(familyExecutionId);
  const cases = [
    ["manifest", "manifest.json", "qualification-cohort-v1"],
    ["provisionPage", "provision-pages/00000000.json", "qualification-cohort-provision-page-v1"],
    ["participantGrant", "grants/free/00000000.json", "qualification-participant-grant-v1"],
    ["finalizePage", "finalize-pages/free/00000000.json", "qualification-cohort-finalize-page-v1"],
    ["inventoryReceipt", "inventory-receipt.json", "qualification-cohort-inventory-v1"],
  ] as const;
  for (const [family, suffix, kind] of cases) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The protocol family sequence is intentionally deterministic.
    expect(
      await stub.retain({
        ...input,
        body: JSON.stringify({ family }),
        executionId: familyExecutionId,
        family,
        key: `qualification/executions/${familyExecutionId}/cohort/${suffix}`,
        metadata: { "osfo-execution-id": familyExecutionId, "osfo-kind": kind },
        operationToken: `family-${family}`,
      }),
    ).toMatchObject({ _tag: "Complete" });
  }
});

it("reconciles applied and unapplied persisted intents before fencing", async () => {
  for (const applied of [true, false]) {
    const caseExecutionId = `${executionId}-${applied ? "applied" : "unapplied"}`;
    const caseKey = `qualification/executions/${caseExecutionId}/cohort/manifest.json`;
    const body = `{"case":"${applied ? "applied" : "unapplied"}"}`;
    const metadata = {
      "osfo-execution-id": caseExecutionId,
      "osfo-kind": "qualification-cohort-v1",
    };
    const digest = await sha256(body);
    if (applied) {
      await runtimeEnv.ARTIFACTS.put(caseKey, body, {
        customMetadata: metadata,
        httpMetadata: { contentType: "application/json" },
        sha256: hexToBytes(digest.slice("sha256:".length)),
      });
    } else {
      await runtimeEnv.ARTIFACTS.delete(caseKey);
    }
    const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(caseExecutionId);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "insert into authority_state (singleton, execution_id, protocol_version, lifecycle) values (1, ?, ?, 'OPEN')",
        caseExecutionId,
        input.protocolVersion,
      );
      state.storage.sql.exec(
        "insert into pending_intent (singleton, artifact_key, family, body_sha256, metadata_digest, operation_token) values (1, ?, 'manifest', ?, ?, 'pending-operation')",
        caseKey,
        digest,
        qualificationChecksum(metadata),
      );
    });

    expect(
      await stub.fence({ executionId: caseExecutionId, protocolVersion: input.protocolVersion }),
    ).toEqual({
      _tag: "Fenced",
      protocolVersion: input.protocolVersion,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec("select * from pending_intent").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("select * from artifact_records").toArray()).toHaveLength(
        applied ? 1 : 0,
      );
    });
  }
});

it("fails fencing when retained bytes conflict with the persisted intent", async () => {
  const caseExecutionId = `${executionId}-conflict`;
  const caseKey = `qualification/executions/${caseExecutionId}/cohort/manifest.json`;
  const metadata = {
    "osfo-execution-id": caseExecutionId,
    "osfo-kind": "qualification-cohort-v1",
  };
  await runtimeEnv.ARTIFACTS.put(caseKey, "wrong-body", {
    customMetadata: metadata,
    httpMetadata: { contentType: "application/json" },
    sha256: hexToBytes((await sha256("wrong-body")).slice("sha256:".length)),
  });
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(caseExecutionId);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      "insert into authority_state (singleton, execution_id, protocol_version, lifecycle) values (1, ?, ?, 'OPEN')",
      caseExecutionId,
      input.protocolVersion,
    );
    state.storage.sql.exec(
      "insert into pending_intent (singleton, artifact_key, family, body_sha256, metadata_digest, operation_token) values (1, ?, 'manifest', ?, ?, 'pending-operation')",
      caseKey,
      await sha256("expected-body"),
      qualificationChecksum(metadata),
    );
  });

  expect(
    await stub.fence({ executionId: caseExecutionId, protocolVersion: input.protocolVersion }),
  ).toEqual({
    _tag: "Conflict",
    code: "pendingIntentConflict",
  });
});

it("rejects cross-execution, family, and key substitutions", async () => {
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(
    `${executionId}-identity`,
  );
  expect(await stub.retain(input)).toEqual({ _tag: "Conflict", code: "executionMismatch" });
  const exactExecutionId = `${executionId}-identity`;
  expect(
    await stub.retain({
      ...input,
      executionId: exactExecutionId,
      key: `qualification/executions/${exactExecutionId}/cohort/grants/free/00000000.json`,
      metadata: {
        ...input.metadata,
        "osfo-execution-id": exactExecutionId,
      },
    }),
  ).toEqual({ _tag: "Conflict", code: "artifactKeyMismatch" });

  const specialExecutionId = "literal*(execution)-identity";
  const specialStub =
    runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(specialExecutionId);
  expect(
    await specialStub.retain({
      ...input,
      executionId: specialExecutionId,
      key: `qualification/executions/${encodeURIComponent(specialExecutionId)}/cohort/manifest.json`,
      metadata: { ...input.metadata, "osfo-execution-id": specialExecutionId },
    }),
  ).toMatchObject({ _tag: "Complete" });
});

it("rejects an operation token reused for another exact key", async () => {
  const caseExecutionId = `${executionId}-token`;
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(caseExecutionId);
  const first = {
    ...input,
    executionId: caseExecutionId,
    key: `qualification/executions/${caseExecutionId}/cohort/manifest.json`,
    metadata: { ...input.metadata, "osfo-execution-id": caseExecutionId },
    operationToken: "reused-token",
  };
  expect(await stub.retain(first)).toMatchObject({ _tag: "Complete" });
  expect(
    await stub.retain({
      ...first,
      family: "inventoryReceipt",
      key: `qualification/executions/${caseExecutionId}/cohort/inventory-receipt.json`,
      metadata: {
        "osfo-execution-id": caseExecutionId,
        "osfo-kind": "qualification-cohort-inventory-v1",
      },
    }),
  ).toEqual({ _tag: "Conflict", code: "operationTokenConflict" });
});

it("returns Busy during an active external write without blocking the Durable Object", async () => {
  const caseExecutionId = `${executionId}-busy`;
  const caseInput = {
    ...input,
    body: JSON.stringify({ payload: "x".repeat(120_000) }),
    executionId: caseExecutionId,
    key: `qualification/executions/${caseExecutionId}/cohort/manifest.json`,
    metadata: { ...input.metadata, "osfo-execution-id": caseExecutionId },
  };
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(caseExecutionId);
  await runInDurableObject(stub, async (instance) => {
    // SAFETY: The test binding names the concrete authority class supplied to runInDurableObject.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const authority = instance as QualificationCohortArtifactAuthority;
    const activeWrite = authority.retain(caseInput);
    expect(await authority.retain({ ...caseInput, operationToken: "concurrent-token" })).toEqual({
      _tag: "Busy",
    });
    expect(
      await authority.fence({
        executionId: caseExecutionId,
        protocolVersion: input.protocolVersion,
      }),
    ).toEqual({ _tag: "Busy" });
    expect(await activeWrite).toMatchObject({ _tag: "Complete" });
  });
  expect(
    await stub.fence({ executionId: caseExecutionId, protocolVersion: input.protocolVersion }),
  ).toEqual({
    _tag: "Fenced",
    protocolVersion: input.protocolVersion,
  });
});

it("bounds metadata and authenticates the retained JSON content type", async () => {
  const boundsExecutionId = `${executionId}-metadata-bounds`;
  const boundsStub =
    runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(boundsExecutionId);
  const invalidMetadata = [
    {
      "osfo-execution-id": boundsExecutionId,
      "osfo-kind": "qualification-cohort-v1",
      oversized: "x".repeat(513),
    },
    {
      ["k".repeat(129)]: "value",
      "osfo-execution-id": boundsExecutionId,
      "osfo-kind": "qualification-cohort-v1",
    },
    Object.fromEntries([
      ["osfo-execution-id", boundsExecutionId],
      ["osfo-kind", "qualification-cohort-v1"],
      ...Array.from({ length: 19 }, (_, index) => [`entry-${index}`, "value"]),
    ]),
    {
      "osfo-execution-id": boundsExecutionId,
      "osfo-kind": "qualification-cohort-v1",
      one: "x".repeat(500),
      two: "x".repeat(500),
      three: "x".repeat(500),
      four: "x".repeat(500),
    },
  ];
  for (const metadata of invalidMetadata) {
    expect(
      await boundsStub.retain({
        ...input,
        executionId: boundsExecutionId,
        key: `qualification/executions/${boundsExecutionId}/cohort/manifest.json`,
        metadata,
      }),
    ).toEqual({ _tag: "Conflict", code: "metadataBoundsInvalid" });
  }

  const contentTypeExecutionId = `${executionId}-content-type`;
  const contentTypeKey = `qualification/executions/${contentTypeExecutionId}/cohort/manifest.json`;
  const metadata = {
    "osfo-execution-id": contentTypeExecutionId,
    "osfo-kind": "qualification-cohort-v1",
  };
  await runtimeEnv.ARTIFACTS.put(contentTypeKey, "{}", {
    customMetadata: metadata,
    httpMetadata: { contentType: "text/plain" },
    sha256: hexToBytes((await sha256("{}")).slice("sha256:".length)),
  });
  const contentTypeStub =
    runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(contentTypeExecutionId);
  await runInDurableObject(contentTypeStub, async (_instance, state) => {
    state.storage.sql.exec(
      "insert into authority_state (singleton, execution_id, protocol_version, lifecycle) values (1, ?, ?, 'OPEN')",
      contentTypeExecutionId,
      input.protocolVersion,
    );
    state.storage.sql.exec(
      "insert into pending_intent (singleton, artifact_key, family, body_sha256, metadata_digest, operation_token) values (1, ?, 'manifest', ?, ?, 'pending-content-type')",
      contentTypeKey,
      await sha256("{}"),
      qualificationChecksum(metadata),
    );
  });
  expect(
    await contentTypeStub.fence({
      executionId: contentTypeExecutionId,
      protocolVersion: input.protocolVersion,
    }),
  ).toEqual({ _tag: "Conflict", code: "pendingIntentConflict" });

  const nativeChecksumExecutionId = `${executionId}-native-checksum`;
  const nativeChecksumKey = `qualification/executions/${nativeChecksumExecutionId}/cohort/manifest.json`;
  const nativeChecksumMetadata = {
    "osfo-execution-id": nativeChecksumExecutionId,
    "osfo-kind": "qualification-cohort-v1",
  };
  await runtimeEnv.ARTIFACTS.put(nativeChecksumKey, "{}", {
    customMetadata: nativeChecksumMetadata,
    httpMetadata: { contentType: "application/json" },
  });
  const nativeChecksumStub =
    runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(nativeChecksumExecutionId);
  await runInDurableObject(nativeChecksumStub, async (_instance, state) => {
    state.storage.sql.exec(
      "insert into authority_state (singleton, execution_id, protocol_version, lifecycle) values (1, ?, ?, 'OPEN')",
      nativeChecksumExecutionId,
      input.protocolVersion,
    );
    state.storage.sql.exec(
      "insert into pending_intent (singleton, artifact_key, family, body_sha256, metadata_digest, operation_token) values (1, ?, 'manifest', ?, ?, 'pending-native-checksum')",
      nativeChecksumKey,
      await sha256("{}"),
      qualificationChecksum(nativeChecksumMetadata),
    );
  });
  expect(
    await nativeChecksumStub.fence({
      executionId: nativeChecksumExecutionId,
      protocolVersion: input.protocolVersion,
    }),
  ).toEqual({ _tag: "Conflict", code: "pendingIntentConflict" });
});

const sha256 = async (body: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
};
