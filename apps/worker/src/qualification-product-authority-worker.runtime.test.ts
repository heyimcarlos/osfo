/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, eslint/no-underscore-dangle -- Runtime tests drive Promise-native Worker handlers and assert closed _tag outcomes with fixed timestamps. */
import { expect, it } from "vitest";
import { Schema } from "effect";

import { AgentId } from "./domain";
import { qualificationAuthoritySources } from "./qualification/authority-sources";
import {
  createQualificationExecutionPlan,
  qualificationRunArrivalAt,
} from "./qualification/execution";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "./qualification/qualification-checksum";
import { createBoundedBetaManifest } from "./qualification/qualification-manifest";
import { ScheduledEmail } from "./services/scheduled-email";
import {
  handleQualificationProductAuthority,
  qualificationMemoryAuthorityRecords,
  qualificationScheduledEmailAuthorityRecords,
  retainQualificationProductAuthorityShard,
} from "./qualification-product-authority-worker";
import { scheduledEmailWorkflowEvidenceArtifactId } from "./workflows/scheduled-email";

it("distinguishes failed, unsettled, and absent Memory obligations", () => {
  const root = { rootId: "root-1", userMessageId: "message-1" };
  expect(
    qualificationMemoryAuthorityRecords({
      ...root,
      outcome: {
        _tag: "NoMemoryObligation",
        occurredAt: "2026-08-29T17:00:00.000Z",
        productFactId: "assistant-1",
        terminalStatus: "error",
      },
    }),
  ).toMatchObject([{ memoryObligation: "notRequired", terminalStatus: "error" }]);
  expect(
    qualificationMemoryAuthorityRecords({
      ...root,
      outcome: {
        completedAt: null,
        outboxId: "memory-outbox-1",
        providerDocumentId: null,
        providerStatus: "processing",
        status: "pending",
        terminalAt: null,
      },
    }),
  ).toEqual([]);
  expect(
    qualificationMemoryAuthorityRecords({
      ...root,
      outcome: {
        completedAt: null,
        outboxId: "memory-outbox-1",
        providerDocumentId: "provider-document-1",
        providerStatus: "failed",
        status: "failed",
        terminalAt: "2026-08-29T17:01:00.000Z",
      },
    }),
  ).toMatchObject([
    {
      commitStatus: "failed",
      memoryCommitId: "memory-outbox-1",
      occurredAt: "2026-08-29T17:01:00.000Z",
    },
  ]);
});

it("projects exact Scheduled Email Applied, NotApplied, and unsettled outcomes", async () => {
  const terminalAt = new Date("2026-08-29T17:01:00.000Z");
  const sendOutcomeAt = new Date("2026-08-29T17:00:30.000Z");
  const context = {
    attemptId: "attempt-1",
    executionId: "execution-1",
    journey: "scheduledEmail" as const,
    offeredAtEpochMs: Date.parse("2026-08-29T17:00:00.000Z"),
    planChecksum: "plan-1",
    region: "americas" as const,
    rootId: "root-1",
    runId: "run-1",
  };
  const base = {
    acceptedAt: new Date("2026-08-29T17:00:10.000Z"),
    cloudflareInstanceId: "scheduled-email-instance-1",
    dueAt: new Date("2026-08-29T17:00:30.000Z"),
    providerLogId: "provider-log-1",
    providerResourceId: "gmail-message-1",
    qualificationContext: context,
    safeFailureCode: null,
    sendAccountedAt: terminalAt,
    sendAccountingBasis: "observed" as const,
    sendOutcomeAt,
    sendReconciliationClaimedAt: null,
    sendReconciliationLeaseExpiresAt: null,
    sendReconciliationRecoveryUsed: false,
    sendStartedAt: new Date("2026-08-29T17:00:30.000Z"),
    state: "success" as const,
    terminalAt,
    workflowId: ScheduledEmail.WorkflowId.make("scheduled-email-workflow-1"),
  };
  const workflowEvidenceFor = (
    state: "canceled" | "failure" | "send_pending_reconciliation" | "success",
    sendStartedAtUtc: string | null = base.sendStartedAt.toISOString(),
  ) => {
    const content = {
      artifactId: scheduledEmailWorkflowEvidenceArtifactId(base.cloudflareInstanceId),
      completedAtUtc: "2026-08-29T17:01:01.000Z",
      dueAtUtc: base.dueAt.toISOString(),
      instanceId: base.cloudflareInstanceId,
      sendStartedAtUtc,
      state,
      terminalAtUtc: state === "send_pending_reconciliation" ? null : terminalAt.toISOString(),
      version: "scheduled-email-workflow-evidence-v1" as const,
      workflowId: base.workflowId,
    };
    return { ...content, artifactChecksum: qualificationChecksum(content) };
  };
  const nowEpochMs = Date.parse("2026-08-29T17:01:02.000Z");
  expect(
    qualificationScheduledEmailAuthorityRecords(
      { ...base, sendOutcome: "applied" },
      workflowEvidenceFor("success"),
      nowEpochMs,
    ),
  ).toMatchObject({
    _tag: "Ready",
    records: {
      gmail_provider_receipts: [{ deliveryStatus: "succeeded", gmailMessageId: "gmail-message-1" }],
      provider_delivery_receipts: [{ providerStatus: "succeeded" }],
      task_compute_receipts: [{ executionStatus: "completed" }],
      workflow_instance_receipts: [{ workflowStatus: "completed" }],
    },
  });
  expect(
    qualificationScheduledEmailAuthorityRecords(
      {
        ...base,
        providerLogId: null,
        providerResourceId: null,
        sendOutcome: "notApplied",
        state: "failure",
      },
      workflowEvidenceFor("failure"),
      nowEpochMs,
    ),
  ).toMatchObject({
    _tag: "Ready",
    records: {
      gmail_provider_receipts: [{ deliveryStatus: "notApplied" }],
      provider_delivery_receipts: [{ providerStatus: "notApplied" }],
      workflow_instance_receipts: [{ workflowStatus: "failed" }],
    },
  });
  expect(
    qualificationScheduledEmailAuthorityRecords(
      {
        ...base,
        sendAccountedAt: null,
        sendAccountingBasis: null,
        sendOutcome: "ambiguous",
        state: "send_pending_reconciliation",
        terminalAt: null,
      },
      workflowEvidenceFor("send_pending_reconciliation"),
      nowEpochMs,
    ),
  ).toMatchObject({ _tag: "Pending", source: "provider_delivery_receipts" });
  const reconciliationClaimedAt = new Date(base.sendStartedAt.getTime() + 300_000);
  const reconciliationLeaseExpiresAt = new Date(reconciliationClaimedAt.getTime() + 60_000);
  const leasedAmbiguity = {
    ...base,
    sendAccountedAt: null,
    sendAccountingBasis: null,
    sendOutcome: "ambiguous" as const,
    sendReconciliationClaimedAt: reconciliationClaimedAt,
    sendReconciliationLeaseExpiresAt: reconciliationLeaseExpiresAt,
    state: "send_pending_reconciliation" as const,
    terminalAt: null,
  };
  expect(
    qualificationScheduledEmailAuthorityRecords(
      leasedAmbiguity,
      workflowEvidenceFor("send_pending_reconciliation"),
      base.sendStartedAt.getTime() + 419_999,
    ),
  ).toMatchObject({ _tag: "Pending", source: "provider_delivery_receipts" });
  expect(
    qualificationScheduledEmailAuthorityRecords(
      leasedAmbiguity,
      workflowEvidenceFor("send_pending_reconciliation"),
      base.sendStartedAt.getTime() + 420_000,
    ),
  ).toEqual({ _tag: "Missing", source: "provider_delivery_receipts" });
  expect(
    qualificationScheduledEmailAuthorityRecords(
      {
        ...base,
        safeFailureCode: "send-outcome-unknown",
        sendAccountingBasis: "conservative",
        sendOutcome: "ambiguous",
        state: "failure",
      },
      workflowEvidenceFor("send_pending_reconciliation"),
      base.sendStartedAt.getTime() + ScheduledEmail.providerEvidenceHorizonMilliseconds + 1,
    ),
  ).toMatchObject({
    _tag: "Ready",
    records: {
      gmail_provider_receipts: [{ deliveryStatus: "failed" }],
      provider_delivery_receipts: [{ providerStatus: "failed" }],
      workflow_instance_receipts: [{ workflowStatus: "failed" }],
    },
  });
  expect(
    qualificationScheduledEmailAuthorityRecords(
      {
        ...base,
        providerLogId: null,
        providerResourceId: null,
        safeFailureCode: "cancel-requested",
        sendAccountedAt: null,
        sendAccountingBasis: null,
        sendOutcome: null,
        sendOutcomeAt: null,
        sendStartedAt: null,
        state: "canceled",
      },
      workflowEvidenceFor("canceled", null),
      nowEpochMs,
    ),
  ).toMatchObject({
    _tag: "Ready",
    records: {
      gmail_provider_receipts: [{ gmailObligation: "notRequired" }],
      provider_delivery_receipts: [{ providerObligation: "notRequired" }],
    },
  });
  expect(
    qualificationScheduledEmailAuthorityRecords(
      {
        ...base,
        providerLogId: null,
        providerResourceId: null,
        safeFailureCode: "unclassified-failure",
        sendAccountedAt: null,
        sendAccountingBasis: null,
        sendOutcome: null,
        sendOutcomeAt: null,
        sendStartedAt: null,
        state: "failure",
      },
      workflowEvidenceFor("failure", null),
      nowEpochMs,
    ),
  ).toEqual({ _tag: "Missing", source: "provider_delivery_receipts" });
  expect(
    qualificationScheduledEmailAuthorityRecords(
      {
        ...base,
        providerLogId: null,
        providerResourceId: null,
        sendOutcome: null,
        sendOutcomeAt: null,
        state: "failure",
      },
      workflowEvidenceFor("failure"),
      nowEpochMs,
    ),
  ).toEqual({ _tag: "Missing", source: "provider_delivery_receipts" });
  expect(
    qualificationScheduledEmailAuthorityRecords(
      { ...base, sendOutcome: "applied" },
      null,
      nowEpochMs,
    ),
  ).toMatchObject({ _tag: "Pending", source: "task_compute_receipts" });
  expect(
    qualificationScheduledEmailAuthorityRecords(
      { ...base, sendOutcome: "applied" },
      null,
      base.sendStartedAt.getTime() + ScheduledEmail.providerEvidenceHorizonMilliseconds,
    ),
  ).toEqual({ _tag: "Missing", source: "task_compute_receipts" });

  const appliedRecords = qualificationScheduledEmailAuthorityRecords(
    { ...base, sendOutcome: "applied" },
    workflowEvidenceFor("success"),
    nowEpochMs,
  );
  if (appliedRecords._tag !== "Ready") {
    throw new Error("Applied Scheduled Email authority must be ready");
  }
  const retained = new Map<string, string>();
  let persistedWrites = 0;
  let putAttempts = 0;
  const bucket = {
    get: (key: string) =>
      Promise.resolve(
        retained.has(key) ? { text: () => Promise.resolve(retained.get(key) ?? "") } : null,
      ),
    list: () => Promise.resolve({ objects: [], truncated: false }),
    put: (
      key: string,
      value: string,
      options: {
        customMetadata: Record<string, string>;
        httpMetadata: { contentType: string };
        onlyIf: { etagDoesNotMatch: "*" };
      },
    ) => {
      putAttempts += 1;
      expect(options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
      if (retained.has(key)) return Promise.resolve(null);
      persistedWrites += 1;
      retained.set(key, value);
      return Promise.resolve({});
    },
  };
  const retainAppliedProviderShard = () =>
    retainQualificationProductAuthorityShard({
      bucket,
      executionId: context.executionId,
      planChecksum: context.planChecksum,
      records: appliedRecords.records.provider_delivery_receipts,
      source: "provider_delivery_receipts",
      sourceVersion: "scheduled-email-source-v1",
      startsAtEpochMs: context.offeredAtEpochMs,
      streamChunkIndex: 0,
    });

  await expect(retainAppliedProviderShard()).resolves.toBe(true);
  const retainedBytes = [...retained.values()][0];
  await expect(retainAppliedProviderShard()).resolves.toBe(true);
  expect(putAttempts).toBe(2);
  expect(persistedWrites).toBe(1);
  expect(retained.size).toBe(1);
  expect([...retained.values()][0]).toBe(retainedBytes);
});

it("retains replay-safe partition-local authority shards and refuses spliced bodies", async () => {
  const retained = new Map<
    string,
    { readonly metadata: Record<string, string>; readonly value: string }
  >();
  const bucket = {
    get: (key: string) => {
      const object = retained.get(key);
      return Promise.resolve(
        object === undefined ? null : { text: () => Promise.resolve(object.value) },
      );
    },
    list: () => Promise.resolve({ objects: [], truncated: false as const }),
    put: (
      key: string,
      value: string,
      options: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { metadata: options.customMetadata ?? {}, value });
      return Promise.resolve({});
    },
  };
  const input = {
    bucket,
    executionId: "chain-execution",
    planChecksum: "chain-plan",
    records: [{ occurredAt: "2026-08-29T17:00:00.000Z", rootId: "root-1" }],
    source: "provider_delivery_receipts" as const,
    sourceVersion: "chain-source-v1",
    startsAtEpochMs: Date.parse("2026-08-29T17:00:00.000Z"),
  };

  await expect(
    retainQualificationProductAuthorityShard({ ...input, streamChunkIndex: 0 }),
  ).resolves.toBe(true);
  await expect(
    retainQualificationProductAuthorityShard({ ...input, streamChunkIndex: 1 }),
  ).resolves.toBe(true);

  const firstKey = [...retained.keys()][0];
  const secondKey = [...retained.keys()][1];
  if (firstKey === undefined || secondKey === undefined) throw new Error("Expected shard keys");
  const first = retained.get(firstKey);
  const second = retained.get(secondKey);
  if (first === undefined || second === undefined) throw new Error("Expected retained chain");
  const decodedSecond = Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({ previousArtifactChecksum: Schema.String, streamChunkIndex: Schema.Int }),
    ),
  )(second.value);
  expect(decodedSecond.previousArtifactChecksum).toBe("NONE");
  expect(decodedSecond.streamChunkIndex).toBe(1);
  expect(second.metadata["osfo-previous-checksum"]).toBe("NONE");

  retained.set(firstKey, {
    ...first,
    value: first.value.replace("root-1", "spliced-root"),
  });
  await expect(
    retainQualificationProductAuthorityShard({ ...input, streamChunkIndex: 0 }),
  ).resolves.toBe(false);
  expect(retained.has(secondKey)).toBe(true);
});

it("refuses the first arrival until the complete cohort inventory receipt exists", async () => {
  const manifest = createBoundedBetaManifest({
    dependencyVersions: {
      "@cloudflare/think": "0.15.1",
      agents: "0.20.1",
      effect: "4.0.0-rc.111",
    },
    hardLimits: [
      { maximum: 128, name: "workerMemory", unit: "MiB" },
      { maximum: 1_000, name: "workerSubrequests", unit: "requests" },
    ],
    sourceVersion: "inventory-test-sha",
    topologyVersion: "cloudflare-v1",
    workloadSeed: 17,
  });
  const plan = createQualificationExecutionPlan(manifest, 0, "inventory-test-execution");
  const requestContent = {
    authoritySources: qualificationAuthoritySources,
    cohortArtifactChecksum: "cohort-checksum",
    cohortArtifactId: "qualification/executions/inventory-test-execution/cohort/manifest.json",
    executionId: plan.executionId,
    manifest,
    manifestChecksum: manifest.manifestChecksum,
    plan,
    planChecksum: plan.planChecksum,
    protocolVersion: "qualification-owner-v1" as const,
    shardRecordLimit: 256 as const,
  };
  const requestArtifactChecksum = qualificationChecksum(requestContent);
  const requestArtifactId = "qualification/executions/inventory-test-execution/owner-request.json";
  const retainedRequest = canonicalQualificationJson({
    ...requestContent,
    artifactChecksum: requestArtifactChecksum,
  });
  let databaseRead = false;
  const firstRun = plan.runs[0];
  if (firstRun === undefined) throw new Error("The bounded plan must contain a run");
  const response = await handleQualificationProductAuthority(
    new Request("https://qualification-product-authority.internal/v1/executions/arrivals", {
      body: canonicalQualificationJson({
        arrivalIndex: 0,
        executionId: plan.executionId,
        manifestChecksum: manifest.manifestChecksum,
        planChecksum: plan.planChecksum,
        requestArtifactChecksum,
        requestArtifactId,
        runId: firstRun.runId,
      }),
      method: "POST",
    }),
    {
      ARTIFACTS: {
        get: (key) =>
          Promise.resolve(
            key === requestArtifactId ? { text: () => Promise.resolve(retainedRequest) } : null,
          ),
        list: () => Promise.resolve({ objects: [], truncated: false }),
        put: () => Promise.resolve(null),
      },
      DB: {
        get connectionString() {
          databaseRead = true;
          return "postgres://inventory-must-not-be-read.invalid/osfo";
        },
      },
    },
  );

  expect(response.status).toBe(424);
  expect(await response.json()).toMatchObject({
    missingSources: [
      expect.objectContaining({
        detail: expect.stringContaining("complete frozen disposable cohort inventory"),
      }),
    ],
    status: "MISSING",
  });
  expect(databaseRead).toBe(false);
});

it("resumes an immutable canonical arrival chunk without replaying product effects", async () => {
  const manifest = createBoundedBetaManifest({
    dependencyVersions: {
      "@cloudflare/think": "0.15.1",
      agents: "0.20.1",
      effect: "4.0.0-rc.111",
    },
    hardLimits: [
      { maximum: 128, name: "workerMemory", unit: "MiB" },
      { maximum: 1_000, name: "workerSubrequests", unit: "requests" },
    ],
    sourceVersion: "resume-test-sha",
    topologyVersion: "cloudflare-v1",
    workloadSeed: 17,
  });
  const plan = createQualificationExecutionPlan(manifest, 0, "resume-test-execution");
  const requestContent = {
    authoritySources: qualificationAuthoritySources,
    cohortArtifactChecksum: "cohort-checksum",
    cohortArtifactId: "qualification/executions/resume-test-execution/cohort/manifest.json",
    executionId: plan.executionId,
    manifest,
    manifestChecksum: manifest.manifestChecksum,
    plan,
    planChecksum: plan.planChecksum,
    protocolVersion: "qualification-owner-v1" as const,
    shardRecordLimit: 256 as const,
  };
  const requestArtifactChecksum = qualificationChecksum(requestContent);
  const requestArtifactId = "qualification/executions/resume-test-execution/owner-request.json";
  const retainedRequest = canonicalQualificationJson({
    ...requestContent,
    artifactChecksum: requestArtifactChecksum,
  });
  const run = plan.runs[0];
  if (run === undefined) throw new Error("The bounded plan must contain a run");
  const arrivals = Array.from({ length: Math.min(256, run.arrivalCount) }, (_, index) => {
    const arrival = qualificationRunArrivalAt(manifest, run, index);
    if (arrival === undefined) throw new Error("The canonical arrival must exist");
    const attemptId = qualificationChecksum({
      executionId: plan.executionId,
      planChecksum: plan.planChecksum,
      rootId: arrival.rootId,
      runId: run.runId,
    });
    const occurredAt = new Date(arrival.offeredAtEpochMs).toISOString();
    const receiptContent = {
      acceptanceReceiptId: `authority:${attemptId}`,
      admissionDecision: "accepted" as const,
      agentId: AgentId.make("resume-agent"),
      attemptId,
      executionId: plan.executionId,
      occurredAt,
      planChecksum: plan.planChecksum,
      productFactId: `authority:${attemptId}`,
      rootId: arrival.rootId,
      runId: run.runId,
      thinkSubmissionId: `submission:${attemptId}`,
      userMessageId: `message:${attemptId}`,
      userUpdateId: `update:${attemptId}`,
    };
    return {
      admissionReceipt: {
        ...receiptContent,
        artifactChecksum: qualificationChecksum(receiptContent),
      },
      arrival,
      attemptId,
      authorityFactId: `authority:${attemptId}`,
      executedAtUtc: occurredAt,
      executionId: plan.executionId,
      rootId: arrival.rootId,
      submittedAtUtc: occurredAt,
    };
  });
  const bodyContent = {
    chunkIndex: 0,
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    previousArtifactChecksum: "NONE",
    records: arrivals,
    runId: run.runId,
    streamChunkIndex: 0,
  };
  const encodedShard = canonicalQualificationJson({
    ...bodyContent,
    bodyChecksum: qualificationChecksum(bodyContent),
  });
  const shardArtifactId =
    "qualification/executions/resume-test-execution/authority-streams/arrivals/partitions/00000000/00000000.json";
  const retained = new Map([
    [requestArtifactId, retainedRequest],
    [shardArtifactId, encodedShard],
  ]);
  let productEffectTouched = false;
  let authorityShardWrites = 0;
  const env = {
    ARTIFACTS: {
      get: (key: string) =>
        Promise.resolve(
          retained.has(key) ? { text: () => Promise.resolve(retained.get(key) ?? "") } : null,
        ),
      list: () => Promise.resolve({ objects: [], truncated: false }),
      put: (key: string, value: string) => {
        authorityShardWrites += 1;
        if (retained.has(key)) return Promise.resolve(null);
        retained.set(key, value);
        return Promise.resolve({});
      },
    },
    DB: {
      get connectionString() {
        productEffectTouched = true;
        return "postgres://resume-must-not-be-read.invalid/osfo";
      },
    },
  };
  const invocation = canonicalQualificationJson({
    chunkIndex: 0,
    executionId: plan.executionId,
    manifestChecksum: manifest.manifestChecksum,
    planChecksum: plan.planChecksum,
    requestArtifactChecksum,
    requestArtifactId,
    runId: run.runId,
  });

  for (let replay = 0; replay < 2; replay += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The second invocation deliberately observes the first immutable replay.
    const response = await handleQualificationProductAuthority(
      new Request("https://qualification-product-authority.internal/v1/executions/arrival-chunks", {
        body: invocation,
        method: "POST",
      }),
      env,
    );
    expect(response.status).toBe(200);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Response inspection is part of the ordered replay assertion.
    expect(await response.json()).toMatchObject({
      artifactId: shardArtifactId,
      chunkIndex: 0,
      recordCount: arrivals.length,
      runId: run.runId,
      status: "COMPLETE",
      streamChunkIndex: 0,
    });
  }
  expect(productEffectTouched).toBe(false);
  expect(authorityShardWrites).toBe(4);
  expect(
    retained.has(
      "qualification/executions/resume-test-execution/producer-authority/worker_admission_receipts/partitions/00000000/00000000.json",
    ),
  ).toBe(true);
  expect(
    retained.has(
      "qualification/executions/resume-test-execution/producer-authority/think_submission_receipts/partitions/00000000/00000000.json",
    ),
  ).toBe(true);
});
