/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop, eslint/no-underscore-dangle -- This suite drives sequential Cloudflare RPC/R2 state transitions and asserts closed _tag outcomes. */
import { env, runInDurableObject } from "cloudflare:test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, it } from "vitest";

import {
  migrateQualificationCohortArtifactAuthority,
  qualificationCohortArtifactMapFive,
  sealQualificationCohortArtifactAuthorityRoot,
  type QualificationCohortArtifactAuthority,
} from "./qualification-cohort-artifact-authority";
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

it("proves one exact page absent, seals it, and retains only content-free progress", async () => {
  const pageExecutionId = `${executionId}-delete-page`;
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(pageExecutionId);
  const keys = [
    `qualification/executions/${pageExecutionId}/cohort/grants/free/00000000.json`,
    `qualification/executions/${pageExecutionId}/cohort/finalize-pages/free/00000000.json`,
    `qualification/executions/${pageExecutionId}/cohort/provision-pages/00000000.json`,
  ];
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks toSorted and this fresh test list needs canonical order.
  keys.sort();
  for (const [index, artifactKey] of keys.entries()) {
    const family = artifactKey.includes("/grants/")
      ? "participantGrant"
      : artifactKey.includes("/finalize-pages/")
        ? "finalizePage"
        : "provisionPage";
    const kind = artifactKey.includes("/grants/")
      ? "qualification-participant-grant-v1"
      : artifactKey.includes("/finalize-pages/")
        ? "qualification-cohort-finalize-page-v1"
        : "qualification-cohort-provision-page-v1";
    expect(
      await stub.retain({
        body: JSON.stringify({ index }),
        executionId: pageExecutionId,
        family,
        key: artifactKey,
        metadata: { "osfo-execution-id": pageExecutionId, "osfo-kind": kind },
        operationToken: `page-${index}`,
        protocolVersion: input.protocolVersion,
      }),
    ).toMatchObject({ _tag: "Complete" });
  }
  expect(
    await stub.fence({ executionId: pageExecutionId, protocolVersion: input.protocolVersion }),
  ).toMatchObject({ _tag: "Fenced" });
  const expectedArtifactsChecksum = qualificationChecksum({ expectedArtifactIds: keys });
  const proven = await stub.deletePage({
    executionId: pageExecutionId,
    expectedArtifactKeys: keys,
    expectedArtifactsChecksum,
    pageIndex: 0,
    plan: "free",
    position: 0,
    previousPageChecksum: "NONE",
    protocolVersion: input.protocolVersion,
  });
  expect(proven).toMatchObject({ _tag: "Proven", expectedArtifactCount: 3, scope: "page" });
  if (proven._tag !== "Proven") return;
  expect(
    await stub.sealPage({
      executionId: pageExecutionId,
      expectedArtifactKeys: keys,
      expectedArtifactsChecksum,
      pageChecksum: "postgres-page-checksum",
      pageIndex: 0,
      plan: "free",
      position: 0,
      previousPageChecksum: "NONE",
      proofChecksum: proven.proofChecksum,
      protocolVersion: input.protocolVersion,
    }),
  ).toMatchObject({ _tag: "Sealed", position: 0 });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(state.storage.sql.exec("select * from artifact_records").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec("select * from delete_intent").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec("select * from sealed_page_receipts").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec("select * from _sql_schema_migrations").toArray()).toHaveLength(
      2,
    );
  });
});

it("authenticates a 4,000-page chain before compacting to one SCRUBBED tombstone", async () => {
  const rootExecutionId = `${executionId}-root-4000`;
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(rootExecutionId);
  const inventoryKey = `qualification/executions/${rootExecutionId}/cohort/inventory-receipt.json`;
  const manifestKey = `qualification/executions/${rootExecutionId}/cohort/manifest.json`;
  const rootKeys = [inventoryKey, manifestKey];
  expect(
    await stub.retain(
      artifactInput(rootExecutionId, inventoryKey, "inventoryReceipt", "root-inventory"),
    ),
  ).toMatchObject({ _tag: "Complete" });
  expect(
    await stub.retain(artifactInput(rootExecutionId, manifestKey, "manifest", "root-manifest")),
  ).toMatchObject({ _tag: "Complete" });
  expect(
    await stub.fence({ executionId: rootExecutionId, protocolVersion: input.protocolVersion }),
  ).toMatchObject({ _tag: "Fenced" });
  await runInDurableObject(stub, async (_instance, state) => {
    let previous = "NONE";
    for (let position = 0; position < 4_000; position += 1) {
      const pageChecksum = `page-${String(position).padStart(4, "0")}`;
      const proofChecksum = `proof-${position}`;
      const expectedArtifactsChecksum = `artifacts-${position}`;
      const artifactRecordsChecksum = `records-${position}`;
      const receiptChecksum = qualificationChecksum({
        artifactRecordsChecksum,
        expectedArtifactCount: 1,
        expectedArtifactsChecksum,
        pageChecksum,
        pageIndex: position,
        plan: "free",
        position,
        previousPageChecksum: previous,
        proofChecksum,
      });
      state.storage.sql.exec(
        `insert into sealed_page_receipts
          (position, plan, page_index, previous_page_checksum, page_checksum, proof_checksum,
           expected_artifact_count, expected_artifacts_checksum, artifact_records_checksum,
           receipt_checksum)
         values (?, 'free', ?, ?, ?, ?, 1, ?, ?, ?)`,
        position,
        position,
        previous,
        pageChecksum,
        proofChecksum,
        expectedArtifactsChecksum,
        artifactRecordsChecksum,
        receiptChecksum,
      );
      previous = pageChecksum;
    }
  });
  const expectedArtifactsChecksum = qualificationChecksum({ expectedArtifactIds: rootKeys });
  const proof = await stub.deleteRoot({
    executionId: rootExecutionId,
    expectedArtifactKeys: rootKeys,
    expectedArtifactsChecksum,
    expectedPageCount: 4_000,
    finalPageChecksum: "page-3999",
    protocolVersion: input.protocolVersion,
  });
  expect(proof).toMatchObject({ _tag: "Proven", expectedArtifactCount: 2, scope: "root" });
  if (proof._tag !== "Proven") return;
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(`create trigger fail_root_compaction
      before delete on sealed_page_receipts
      begin select raise(abort, 'forced root compaction failure'); end`);
    expect(() =>
      sealQualificationCohortArtifactAuthorityRoot(state.storage, "postgres-root-checksum"),
    ).toThrow("forced root compaction failure");
    expect(state.storage.sql.exec("select * from authority_state").one()).toMatchObject({
      lifecycle: "FENCED",
      root_checksum: null,
    });
    expect(state.storage.sql.exec("select * from artifact_records").toArray()).toHaveLength(2);
    expect(state.storage.sql.exec("select * from delete_intent").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec("select * from sealed_page_receipts").toArray()).toHaveLength(
      4_000,
    );
    state.storage.sql.exec("drop trigger fail_root_compaction");
  });
  expect(
    await stub.sealRoot({
      executionId: rootExecutionId,
      proofChecksum: proof.proofChecksum,
      protocolVersion: input.protocolVersion,
      rootChecksum: "postgres-root-checksum",
    }),
  ).toEqual({ _tag: "Scrubbed", rootChecksum: "postgres-root-checksum" });
  expect(
    await stub.inspect({ executionId: rootExecutionId, protocolVersion: input.protocolVersion }),
  ).toEqual({ _tag: "Scrubbed", rootChecksum: "postgres-root-checksum" });
  expect(
    await stub.retain(artifactInput(rootExecutionId, manifestKey, "manifest", "late")),
  ).toEqual({
    _tag: "Fenced",
  });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(state.storage.sql.exec("select * from artifact_records").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec("select * from delete_intent").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec("select * from sealed_page_receipts").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec("select * from authority_state").toArray()).toEqual([
      expect.objectContaining({
        execution_id: rootExecutionId,
        lifecycle: "SCRUBBED",
        protocol_version: input.protocolVersion,
        root_checksum: "postgres-root-checksum",
        singleton: 1,
      }),
    ]);
  });
});

it("atomically retries a failed v1 to v2 migration without losing its fence", async () => {
  const migrationExecutionId = `${executionId}-v1-migration`;
  const stub =
    runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(migrationExecutionId);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("drop table sealed_page_receipts");
    state.storage.sql.exec("drop table delete_intent");
    state.storage.sql.exec("drop table authority_state");
    state.storage.sql.exec("delete from _sql_schema_migrations");
    state.storage.sql.exec(`create table authority_state (
      singleton integer primary key check (singleton = 1), execution_id text not null,
      protocol_version text not null, lifecycle text not null check (lifecycle in ('OPEN', 'FENCED'))
    )`);
    state.storage.sql.exec(
      "insert into authority_state values (1, ?, ?, 'FENCED')",
      migrationExecutionId,
      input.protocolVersion,
    );
    state.storage.sql.exec("create table delete_intent (blocker text)");
    expect(() => migrateQualificationCohortArtifactAuthority(state.storage)).toThrow(
      "delete_intent",
    );
    expect(state.storage.sql.exec("select version from _sql_schema_migrations").toArray()).toEqual([
      { version: 1 },
    ]);
    expect(
      state.storage.sql
        .exec("select name from sqlite_schema where name = 'authority_state_v2'")
        .toArray(),
    ).toEqual([]);
    expect(state.storage.sql.exec("select * from authority_state").one()).toEqual({
      execution_id: migrationExecutionId,
      lifecycle: "FENCED",
      protocol_version: input.protocolVersion,
      singleton: 1,
    });
    state.storage.sql.exec("drop table delete_intent");
    migrateQualificationCohortArtifactAuthority(state.storage);
    expect(state.storage.sql.exec("select version from _sql_schema_migrations").toArray()).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    expect(state.storage.sql.exec("select * from authority_state").one()).toMatchObject({
      execution_id: migrationExecutionId,
      lifecycle: "FENCED",
      root_checksum: null,
    });
  });
});

it("treats exact pre-absence as replay progress and rejects missing or tampered authority", async () => {
  const caseExecutionId = `${executionId}-absence-replay`;
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(caseExecutionId);
  const absentKey = `qualification/executions/${caseExecutionId}/cohort/finalize-pages/free/00000000.json`;
  const presentKey = `qualification/executions/${caseExecutionId}/cohort/grants/free/00000000.json`;
  const keys = [absentKey, presentKey];
  for (const [index, artifactKey] of keys.entries()) {
    const family = index === 0 ? "finalizePage" : "participantGrant";
    const kind =
      index === 0 ? "qualification-cohort-finalize-page-v1" : "qualification-participant-grant-v1";
    expect(
      await stub.retain({
        body: JSON.stringify({ index }),
        executionId: caseExecutionId,
        family,
        key: artifactKey,
        metadata: { "osfo-execution-id": caseExecutionId, "osfo-kind": kind },
        operationToken: `absence-${index}`,
        protocolVersion: input.protocolVersion,
      }),
    ).toMatchObject({ _tag: "Complete" });
  }
  await runtimeEnv.ARTIFACTS.delete(absentKey);
  expect(
    await stub.fence({ executionId: caseExecutionId, protocolVersion: input.protocolVersion }),
  ).toMatchObject({ _tag: "Fenced" });
  const expectedArtifactsChecksum = qualificationChecksum({ expectedArtifactIds: keys });
  const exact = await stub.deletePage({
    executionId: caseExecutionId,
    expectedArtifactKeys: keys,
    expectedArtifactsChecksum,
    pageIndex: 0,
    plan: "free",
    position: 0,
    previousPageChecksum: "NONE",
    protocolVersion: input.protocolVersion,
  });
  expect(exact).toMatchObject({ _tag: "Proven", expectedArtifactCount: 2 });
  expect(
    await stub.deletePage({
      executionId: caseExecutionId,
      expectedArtifactKeys: keys,
      expectedArtifactsChecksum,
      pageIndex: 0,
      plan: "free",
      position: 0,
      previousPageChecksum: "NONE",
      protocolVersion: input.protocolVersion,
    }),
  ).toEqual(exact);

  const corruptExecutionId = `${executionId}-delete-corrupt`;
  const corruptKey = `qualification/executions/${corruptExecutionId}/cohort/finalize-pages/free/00000000.json`;
  const corruptStub =
    runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(corruptExecutionId);
  expect(
    await corruptStub.retain({
      body: "exact",
      executionId: corruptExecutionId,
      family: "finalizePage",
      key: corruptKey,
      metadata: {
        "osfo-execution-id": corruptExecutionId,
        "osfo-kind": "qualification-cohort-finalize-page-v1",
      },
      operationToken: "corrupt-record",
      protocolVersion: input.protocolVersion,
    }),
  ).toMatchObject({ _tag: "Complete" });
  expect(
    await corruptStub.fence({
      executionId: corruptExecutionId,
      protocolVersion: input.protocolVersion,
    }),
  ).toMatchObject({ _tag: "Fenced" });
  await runtimeEnv.ARTIFACTS.put(corruptKey, "substituted", {
    customMetadata: {
      "osfo-execution-id": corruptExecutionId,
      "osfo-kind": "qualification-cohort-finalize-page-v1",
    },
    httpMetadata: { contentType: "application/json" },
    sha256: hexToBytes((await sha256("substituted")).slice("sha256:".length)),
  });
  expect(
    await corruptStub.deletePage({
      executionId: corruptExecutionId,
      expectedArtifactKeys: [corruptKey],
      expectedArtifactsChecksum: qualificationChecksum({ expectedArtifactIds: [corruptKey] }),
      pageIndex: 0,
      plan: "free",
      position: 0,
      previousPageChecksum: "NONE",
      protocolVersion: input.protocolVersion,
    }),
  ).toEqual({ _tag: "Conflict", code: "retainedArtifactMismatch" });
  await runInDurableObject(corruptStub, async (_instance, state) => {
    state.storage.sql.exec("delete from delete_intent");
    state.storage.sql.exec("delete from artifact_records");
  });
  expect(
    await corruptStub.deletePage({
      executionId: corruptExecutionId,
      expectedArtifactKeys: [corruptKey],
      expectedArtifactsChecksum: qualificationChecksum({ expectedArtifactIds: [corruptKey] }),
      pageIndex: 0,
      plan: "free",
      position: 0,
      previousPageChecksum: "NONE",
      protocolVersion: input.protocolVersion,
    }),
  ).toEqual({ _tag: "Missing", code: "artifactAuthorityRecordMissing" });
});

it("refuses root deletion before the exact page chain is sealed", async () => {
  const caseExecutionId = `${executionId}-root-before-pages`;
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(caseExecutionId);
  const inventoryKey = `qualification/executions/${caseExecutionId}/cohort/inventory-receipt.json`;
  const manifestKey = `qualification/executions/${caseExecutionId}/cohort/manifest.json`;
  const keys = [inventoryKey, manifestKey];
  expect(
    await stub.retain(
      artifactInput(caseExecutionId, inventoryKey, "inventoryReceipt", "early-root-1"),
    ),
  ).toMatchObject({ _tag: "Complete" });
  expect(
    await stub.retain(artifactInput(caseExecutionId, manifestKey, "manifest", "early-root-2")),
  ).toMatchObject({ _tag: "Complete" });
  expect(
    await stub.fence({ executionId: caseExecutionId, protocolVersion: input.protocolVersion }),
  ).toMatchObject({ _tag: "Fenced" });
  expect(
    await stub.deleteRoot({
      executionId: caseExecutionId,
      expectedArtifactKeys: keys,
      expectedArtifactsChecksum: qualificationChecksum({ expectedArtifactIds: keys }),
      expectedPageCount: 1,
      finalPageChecksum: "not-sealed",
      protocolVersion: input.protocolVersion,
    }),
  ).toEqual({ _tag: "Missing", code: "sealedPageChainIncomplete" });

  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `insert into sealed_page_receipts
        (position, plan, page_index, previous_page_checksum, page_checksum, proof_checksum,
         expected_artifact_count, expected_artifacts_checksum, artifact_records_checksum,
         receipt_checksum)
       values (0, 'free', 0, 'NONE', 'not-sealed', 'proof', 1, 'artifacts', 'records',
               'tampered-receipt')`,
    );
  });
  expect(
    await stub.deleteRoot({
      executionId: caseExecutionId,
      expectedArtifactKeys: keys,
      expectedArtifactsChecksum: qualificationChecksum({ expectedArtifactIds: keys }),
      expectedPageCount: 1,
      finalPageChecksum: "not-sealed",
      protocolVersion: input.protocolVersion,
    }),
  ).toEqual({ _tag: "Conflict", code: "sealedPageChainConflict" });
});

it("bounds every R2 HEAD batch to five active calls", async () => {
  let active = 0;
  let maximumActive = 0;
  const values = await qualificationCohortArtifactMapFive(
    Array.from({ length: 27 }, (_, index) => index),
    async (index) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return index;
    },
  );
  expect(values).toEqual(Array.from({ length: 27 }, (_, index) => index));
  expect(maximumActive).toBe(5);
});

it("rejects native SHA, custom-metadata, and content-type substitutions during deletion", async () => {
  for (const variant of ["metadata", "nativeSha", "contentType"] as const) {
    const caseExecutionId = `${executionId}-delete-${variant}`;
    const artifactKey = `qualification/executions/${caseExecutionId}/cohort/finalize-pages/free/00000000.json`;
    const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(caseExecutionId);
    const metadata = {
      "osfo-execution-id": caseExecutionId,
      "osfo-kind": "qualification-cohort-finalize-page-v1",
    };
    expect(
      await stub.retain({
        body: "exact",
        executionId: caseExecutionId,
        family: "finalizePage",
        key: artifactKey,
        metadata,
        operationToken: `tamper-${variant}`,
        protocolVersion: input.protocolVersion,
      }),
    ).toMatchObject({ _tag: "Complete" });
    expect(
      await stub.fence({ executionId: caseExecutionId, protocolVersion: input.protocolVersion }),
    ).toMatchObject({ _tag: "Fenced" });
    const putOptions = {
      customMetadata: variant === "metadata" ? { ...metadata, substituted: "true" } : metadata,
      httpMetadata: {
        contentType: variant === "contentType" ? "text/plain" : "application/json",
      },
    };
    await runtimeEnv.ARTIFACTS.put(
      artifactKey,
      "exact",
      variant === "nativeSha"
        ? putOptions
        : {
            ...putOptions,
            sha256: hexToBytes((await sha256("exact")).slice("sha256:".length)),
          },
    );
    expect(
      await stub.deletePage({
        executionId: caseExecutionId,
        expectedArtifactKeys: [artifactKey],
        expectedArtifactsChecksum: qualificationChecksum({ expectedArtifactIds: [artifactKey] }),
        pageIndex: 0,
        plan: "free",
        position: 0,
        previousPageChecksum: "NONE",
        protocolVersion: input.protocolVersion,
      }),
    ).toEqual({ _tag: "Conflict", code: "retainedArtifactMismatch" });
  }
});

it("reconciles an eviction-shaped ARMED intent after delete applied but its response was lost", async () => {
  const caseExecutionId = `${executionId}-lost-delete-response`;
  const artifactKey = `qualification/executions/${caseExecutionId}/cohort/finalize-pages/free/00000000.json`;
  const stub = runtimeEnv.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY_TEST.getByName(caseExecutionId);
  expect(
    await stub.retain({
      body: "lost-response",
      executionId: caseExecutionId,
      family: "finalizePage",
      key: artifactKey,
      metadata: {
        "osfo-execution-id": caseExecutionId,
        "osfo-kind": "qualification-cohort-finalize-page-v1",
      },
      operationToken: "lost-response-artifact",
      protocolVersion: input.protocolVersion,
    }),
  ).toMatchObject({ _tag: "Complete" });
  expect(
    await stub.fence({ executionId: caseExecutionId, protocolVersion: input.protocolVersion }),
  ).toMatchObject({ _tag: "Fenced" });
  const expectedArtifactKeys = [artifactKey];
  const expectedArtifactsChecksum = qualificationChecksum({
    expectedArtifactIds: expectedArtifactKeys,
  });
  const operationId = await runInDurableObject(stub, async (_instance, state) => {
    const record = state.storage.sql
      .exec<{
        artifact_key: string;
        body_sha256: string;
        family: string;
        metadata_digest: string;
        operation_token: string;
      }>("select * from artifact_records")
      .one();
    const artifactRecordsChecksum = qualificationChecksum({
      records: [
        {
          artifactKey: record.artifact_key,
          bodySha256: record.body_sha256,
          family: record.family,
          metadataDigest: record.metadata_digest,
          operationToken: record.operation_token,
        },
      ],
    });
    const retainedOperationId = qualificationChecksum({
      artifactRecordsChecksum,
      executionId: caseExecutionId,
      expectedArtifactCount: 1,
      expectedArtifactsChecksum,
      pageIndex: 0,
      plan: "free",
      position: 0,
      previousPageChecksum: "NONE",
      scope: "page",
    });
    state.storage.sql.exec(
      `insert into delete_intent
        (singleton, scope, operation_id, phase, expected_artifact_count,
         expected_artifacts_checksum, artifact_records_checksum, proof_checksum, plan, page_index,
         position, previous_page_checksum, expected_page_count, final_page_checksum)
       values (1, 'page', ?, 'ARMED', 1, ?, ?, null, 'free', 0, 0, 'NONE', null, null)`,
      retainedOperationId,
      expectedArtifactsChecksum,
      artifactRecordsChecksum,
    );
    return retainedOperationId;
  });
  await runtimeEnv.ARTIFACTS.delete(artifactKey);
  expect(
    await stub.deletePage({
      executionId: caseExecutionId,
      expectedArtifactKeys,
      expectedArtifactsChecksum,
      pageIndex: 0,
      plan: "free",
      position: 0,
      previousPageChecksum: "NONE",
      protocolVersion: input.protocolVersion,
    }),
  ).toMatchObject({ _tag: "Proven", operationId });
});

const artifactInput = (
  artifactExecutionId: string,
  artifactKey: string,
  family: "inventoryReceipt" | "manifest",
  operationToken: string,
) => ({
  body: JSON.stringify({ family }),
  executionId: artifactExecutionId,
  family,
  key: artifactKey,
  metadata: {
    "osfo-execution-id": artifactExecutionId,
    "osfo-kind":
      family === "manifest" ? "qualification-cohort-v1" : "qualification-cohort-inventory-v1",
  },
  operationToken,
  protocolVersion: input.protocolVersion,
});

const sha256 = async (body: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
};
