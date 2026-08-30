/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, eslint/no-underscore-dangle -- Runtime tests drive Promise-native Worker handlers and assert closed _tag outcomes with fixed timestamps. */
import { expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import { AgentId, AllowancePeriodId, SessionId, UserId } from "./domain";
import { ContentId } from "./domain/client-content";
import { FileDigest } from "./domain/file-content";
import { FileId } from "./domain/file";
import { DocumentBuild } from "./services/document-build";
import {
  contentKeyFor,
  qualificationReceiptKeyFor,
} from "./integrations/cloudflare/document-storage-keys";
import { qualificationAuthoritySources } from "./qualification/authority-sources";
import {
  createQualificationExecutionPlan,
  qualificationRunArrivalAt,
} from "./qualification/execution";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "./qualification/qualification-checksum";
import { QualificationAdmissionReceipt } from "./qualification/qualification-attempt";
import {
  qualificationControlledAgentAbortOperationId,
  qualificationControlledAgentFaultReceipt,
  qualificationControlledAgentRecoveryReceipt,
} from "./qualification/controlled-agent-fault";
import { createBoundedBetaManifest } from "./qualification/qualification-manifest";
import { ScheduledEmail } from "./services/scheduled-email";
import {
  collectQualificationSourceBundle,
  controlledAgentFaultPreparedBeforeOffer,
  handleQualificationProductAuthority,
  mapQualificationAuthorityConnections,
  qualificationActivationAuthorityRecords,
  qualificationAuthorityConnectionLimit,
  qualificationMemoryAuthorityRecords,
  qualificationDocumentAttemptAuthorityExact,
  qualificationDocumentBuildAuthorityExact,
  qualificationDocumentR2AuthorityRecords,
  qualificationScheduledEmailAuthorityRecords,
  retainQualificationProductAuthorityShard,
} from "./qualification-product-authority-worker";
import type { QualificationProductAuthorityArtifactBucket } from "./qualification-product-authority-worker";
import { scheduledEmailWorkflowEvidenceArtifactId } from "./workflows/scheduled-email";

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const documentR2ChunkFixture = async (count: number) => {
  const executionId = "document-r2-bounded-execution";
  const runId = "document-r2-bounded-run";
  const planChecksum = "document-r2-bounded-plan";
  const digest = "ab".repeat(32);
  const receiptBodies = new Map<string, string>();
  const receiptMetadata = new Map<string, Record<string, string>>();
  const objects = new Map<string, QualificationProductAuthorityHeadObjectFixture>();
  const builds = new Array<Parameters<typeof qualificationDocumentR2AuthorityRecords>[1][number]>();
  for (let index = 0; index < count; index += 1) {
    const workflowId = DocumentBuild.WorkflowId.make(`document-build:bounded-${index}`);
    const contentId = ContentId.make(`document:workflow:${workflowId}`);
    const context = {
      attemptId: `document-r2-attempt-${index}`,
      executionId,
      journey: "documentBuild" as const,
      offeredAtEpochMs: 1_788_000_000_000 + index,
      planChecksum,
      region: "americas" as const,
      rootId: `document-r2-root-${index}`,
      runId,
    };
    const encodedMetadata = canonicalQualificationJson({
      allowancePeriodId: "document-r2-period",
      artifact: {
        artifactRole: { _tag: "GeneratedDocumentV1", format: "pdf", pageCount: 1 },
        content: {
          byteLength: 3,
          contentId,
          mediaType: "application/pdf",
          sha256: digest,
        },
        lineage: { sourceContentId: null },
      },
      cost: { _tag: "ProvenNoUse" },
      format: "pdf",
      intentDigest: "cd".repeat(32),
      owner: { _tag: "Workflow", workflowId },
      qualificationContext: context,
      retention: "accounted",
      userId: "document-r2-user",
    });
    const objectKey = contentKeyFor(contentId);
    const object = {
      checksums: {
        sha256: hexToBytes(digest).buffer,
        toJSON: () => ({ sha256: digest }),
      },
      customMetadata: {
        "osfo-sha256": digest,
        osfo: encodedMetadata,
        osfoAttemptId: context.attemptId,
        osfoExecutionId: executionId,
        osfoObjectId: contentId,
        osfoPlanChecksum: planChecksum,
        osfoRootId: context.rootId,
        osfoRunId: runId,
      },
      etag: `document-r2-etag-${index}`,
      key: objectKey,
      size: 3,
      storageClass: "Standard",
      uploaded: new Date(1_788_000_000_000 + index),
      version: `document-r2-version-${index}`,
    } satisfies QualificationProductAuthorityHeadObjectFixture;
    objects.set(objectKey, object);
    const artifactId = qualificationReceiptKeyFor(executionId, runId, contentId);
    const content = {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The fixture preserves canonical root order while deriving each immutable body.
      accountedMetadataSha256: await sha256Hex(encodedMetadata),
      artifactId,
      attemptId: context.attemptId,
      byteLength: 3,
      contentSha256: digest,
      etag: object.etag,
      executionId,
      mediaType: "application/pdf",
      objectId: contentId,
      objectKey,
      objectVersion: object.version,
      planChecksum,
      rootId: context.rootId,
      runId,
      storageClass: object.storageClass,
      uploadedAtUtc: object.uploaded.toISOString(),
      workflowId,
    };
    const receipt = { ...content, artifactChecksum: qualificationChecksum(content) };
    const encodedReceipt = canonicalQualificationJson(receipt);
    receiptBodies.set(artifactId, encodedReceipt);
    receiptMetadata.set(artifactId, {
      "osfo-artifact-checksum": receipt.artifactChecksum,
      // oxlint-disable-next-line eslint/no-await-in-loop -- The fixture preserves canonical root order while deriving each immutable body.
      "osfo-body-sha256": await sha256Hex(encodedReceipt),
      "osfo-execution-id": executionId,
      "osfo-kind": "qualification-document-object-receipt-v1",
      "osfo-object-id": contentId,
      "osfo-plan-checksum": planChecksum,
      "osfo-root-id": context.rootId,
      "osfo-run-id": runId,
    });
    builds.push({
      artifactAccountedAt: object.uploaded,
      artifactContentId: contentId,
      qualificationContext: context,
      request: DocumentBuild.StoredRequest.make({
        fileSnapshots: [
          {
            byteLength: 1n,
            fileId: FileId.make(`document-r2-file-${index}`),
            mediaType: "text/plain",
            sha256: FileDigest.make(`sha256:${"ef".repeat(32)}`),
          },
        ],
        format: "pdf",
        source: { pages: [{ lines: ["qualification"], title: "Qualification" }] },
      }),
      state: "success",
      workflowId,
    });
  }
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const bounded = async <A>(evaluate: () => A): Promise<A> => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    try {
      return evaluate();
    } finally {
      active -= 1;
    }
  };
  const bucket: QualificationProductAuthorityArtifactBucket = {
    get: (key) =>
      bounded(() => {
        const encoded = receiptBodies.get(key);
        return encoded === undefined
          ? null
          : {
              customMetadata: receiptMetadata.get(key),
              text: () => Promise.resolve(encoded),
            };
      }),
    head: (key) => bounded(() => objects.get(key) ?? null),
    list: () => Promise.resolve({ objects: [], truncated: false }),
    put: () => Promise.resolve(null),
  };
  return {
    bucket,
    builds,
    calls: () => calls,
    maximumActive: () => maximumActive,
    swapFirstReceipts: () => {
      const [first, second] = [...receiptBodies.keys()];
      if (first === undefined || second === undefined) throw new Error("Expected two receipts");
      const firstBody = receiptBodies.get(first);
      const firstMetadata = receiptMetadata.get(first);
      const secondBody = receiptBodies.get(second);
      const secondMetadata = receiptMetadata.get(second);
      if (
        firstBody === undefined ||
        firstMetadata === undefined ||
        secondBody === undefined ||
        secondMetadata === undefined
      ) {
        throw new Error("Expected retained receipt authority");
      }
      receiptBodies.set(first, secondBody);
      receiptMetadata.set(first, secondMetadata);
      receiptBodies.set(second, firstBody);
      receiptMetadata.set(second, firstMetadata);
    },
  };
};

interface QualificationProductAuthorityHeadObjectFixture {
  readonly checksums: {
    readonly sha256: ArrayBuffer;
    readonly toJSON: () => { readonly sha256: string };
  };
  readonly customMetadata: Record<string, string>;
  readonly etag: string;
  readonly key: string;
  readonly size: number;
  readonly storageClass: string;
  readonly uploaded: Date;
  readonly version: string;
}

it("bounds product-authority host calls below the Workers connection ceiling", async () => {
  let active = 0;
  let maximumActive = 0;
  const results = await mapQualificationAuthorityConnections(
    Array.from({ length: 37 }, (_, index) => index),
    async (index) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return index;
    },
  );
  expect(results).toEqual(Array.from({ length: 37 }, (_, index) => index));
  expect(maximumActive).toBe(qualificationAuthorityConnectionLimit);
  expect(maximumActive).toBeLessThan(6);
});

it("authenticates a full Document Build R2 chunk in fewer than 600 bounded calls", async () => {
  const fixture = await documentR2ChunkFixture(256);
  const outcome = await qualificationDocumentR2AuthorityRecords(fixture.bucket, fixture.builds);

  expect(outcome).toMatchObject({ _tag: "Ready" });
  if (outcome._tag !== "Ready") return;
  expect(outcome.records).toHaveLength(256);
  expect(fixture.calls()).toBe(512);
  expect(fixture.maximumActive()).toBe(qualificationAuthorityConnectionLimit);
  expect(fixture.maximumActive()).toBeLessThan(6);
});

it("rejects an exact-key Document Build receipt substitution", async () => {
  const fixture = await documentR2ChunkFixture(2);
  fixture.swapFirstReceipts();
  await expect(
    qualificationDocumentR2AuthorityRecords(fixture.bucket, fixture.builds),
  ).resolves.toEqual({ _tag: "Conflict" });
});

it("rejects cross-plan, cross-run, User, and Session Document Build authority", () => {
  const manifest = createBoundedBetaManifest({
    dependencyVersions: {
      "@cloudflare/think": "0.15.1",
      agents: "0.20.1",
      effect: "4.0.0-rc.111",
    },
    hardLimits: [{ maximum: 1_000, name: "sqlQueries", unit: "queries" }],
    sourceVersion: "document-r2-join-sha",
    topologyVersion: "cloudflare-v1",
    workloadSeed: 17,
  });
  const plan = createQualificationExecutionPlan(manifest, 0, "document-r2-join-execution");
  const run = plan.runs[0];
  if (run === undefined) throw new Error("Expected qualification run");
  const arrival = qualificationRunArrivalAt(manifest, run, 0);
  if (arrival === undefined) throw new Error("Expected qualification arrival");
  const attemptId = qualificationChecksum({
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    rootId: arrival.rootId,
    runId: run.runId,
  });
  const receiptContent = {
    acceptanceReceiptId: `acceptance:${attemptId}`,
    admissionDecision: "accepted" as const,
    agentId: AgentId.make("document-r2-agent"),
    attemptId,
    executionId: plan.executionId,
    occurredAt: new Date(arrival.offeredAtEpochMs).toISOString(),
    planChecksum: plan.planChecksum,
    productFactId: `admission:${attemptId}`,
    rootId: arrival.rootId,
    runId: run.runId,
    thinkSubmissionId: `submission:${attemptId}`,
    userMessageId: `message:${attemptId}`,
    userUpdateId: `update:${attemptId}`,
  };
  const admissionReceipt = QualificationAdmissionReceipt.make({
    ...receiptContent,
    artifactChecksum: qualificationChecksum(receiptContent),
  });
  const identity = {
    admissionDecision: "accepted",
    admissionFactId: admissionReceipt.productFactId,
    agentId: admissionReceipt.agentId,
    allowancePeriodId: AllowancePeriodId.make("document-r2-period"),
    attemptId,
    executionId: plan.executionId,
    journey: "journey" in arrival ? arrival.journey : "ordinaryConversation",
    offeredAt: new Date(arrival.offeredAtEpochMs),
    planChecksum: plan.planChecksum,
    rootId: arrival.rootId,
    runId: run.runId,
    sessionId: SessionId.make("document-r2-session"),
    state: "DECIDED",
    submissionId: admissionReceipt.thinkSubmissionId ?? "",
    userId: UserId.make("document-r2-user"),
  };
  const record = {
    admissionReceipt,
    arrival,
    attemptId,
    authorityFactId: admissionReceipt.productFactId,
    executedAtUtc: admissionReceipt.occurredAt,
    executionId: plan.executionId,
    rootId: arrival.rootId,
    submittedAtUtc: admissionReceipt.occurredAt,
  };
  const exactAttempt = {
    arrivalIndexOffset: 0,
    executionId: plan.executionId,
    identities: [identity],
    manifest,
    planChecksum: plan.planChecksum,
    records: [record],
    run,
  };
  expect(qualificationDocumentAttemptAuthorityExact(exactAttempt)).toBe(true);
  expect(
    qualificationDocumentAttemptAuthorityExact({
      ...exactAttempt,
      identities: [{ ...identity, planChecksum: "substituted-plan" }],
    }),
  ).toBe(false);
  expect(
    qualificationDocumentAttemptAuthorityExact({
      ...exactAttempt,
      identities: [{ ...identity, runId: "substituted-run" }],
    }),
  ).toBe(false);
  expect(
    qualificationDocumentAttemptAuthorityExact({
      ...exactAttempt,
      identities: [{ ...identity, offeredAt: new Date(arrival.offeredAtEpochMs + 1) }],
    }),
  ).toBe(false);
  expect(
    qualificationDocumentAttemptAuthorityExact({
      ...exactAttempt,
      identities: [{ ...identity, journey: "documentBuild" }],
    }),
  ).toBe(false);

  const context = {
    attemptId,
    executionId: plan.executionId,
    journey: "documentBuild" as const,
    offeredAtEpochMs: arrival.offeredAtEpochMs,
    planChecksum: plan.planChecksum,
    region: run.region,
    rootId: arrival.rootId,
    runId: run.runId,
  };
  const buildIdentity = {
    agentId: identity.agentId,
    allowancePeriodId: identity.allowancePeriodId,
    qualificationContext: context,
    sessionId: identity.sessionId,
    userId: identity.userId,
  };
  const documentIdentity = { ...identity, journey: "documentBuild" };
  expect(
    qualificationDocumentBuildAuthorityExact(
      [buildIdentity],
      [documentIdentity],
      plan.planChecksum,
      run.runId,
    ),
  ).toBe(true);
  expect(
    qualificationDocumentBuildAuthorityExact(
      [{ ...buildIdentity, userId: UserId.make("substituted-user") }],
      [documentIdentity],
      plan.planChecksum,
      run.runId,
    ),
  ).toBe(false);
  expect(
    qualificationDocumentBuildAuthorityExact(
      [{ ...buildIdentity, sessionId: SessionId.make("substituted-session") }],
      [documentIdentity],
      plan.planChecksum,
      run.runId,
    ),
  ).toBe(false);
  expect(
    qualificationDocumentBuildAuthorityExact(
      [{ ...buildIdentity, agentId: AgentId.make("substituted-agent") }],
      [documentIdentity],
      plan.planChecksum,
      run.runId,
    ),
  ).toBe(false);
  expect(
    qualificationDocumentBuildAuthorityExact(
      [{ ...buildIdentity, allowancePeriodId: AllowancePeriodId.make("substituted-period") }],
      [documentIdentity],
      plan.planChecksum,
      run.runId,
    ),
  ).toBe(false);
});

it("requires both applied and restored authority before the exact first offer", () => {
  const offeredAtEpochMs = Date.parse("2026-08-29T17:00:01.000Z");
  expect(
    controlledAgentFaultPreparedBeforeOffer({
      appliedAtUtc: "2026-08-29T17:00:00.000Z",
      offeredAtEpochMs,
      recoveredAtUtc: "2026-08-29T17:00:00.999Z",
    }),
  ).toBe(true);
  expect(
    controlledAgentFaultPreparedBeforeOffer({
      appliedAtUtc: "2026-08-29T17:00:00.000Z",
      offeredAtEpochMs,
      recoveredAtUtc: "2026-08-29T17:00:01.001Z",
    }),
  ).toBe(false);
  expect(
    controlledAgentFaultPreparedBeforeOffer({
      appliedAtUtc: "invalid",
      offeredAtEpochMs,
      recoveredAtUtc: "2026-08-29T17:00:00.999Z",
    }),
  ).toBe(false);
});

it("rejects malformed or cross-root substituted Agent activation authority", () => {
  const admissions = [
    activationAdmission("attempt-1", "root-1", "submission-1"),
    activationAdmission("attempt-2", "root-2", "submission-2"),
  ];
  const identities = admissions.map((admission) => ({
    attemptId: admission.attemptId,
    rootId: admission.rootId,
    sessionId: "session-1",
    submissionId: admission.thinkSubmissionId ?? "",
  }));
  const receipts = admissions.map((admission) =>
    activationReceipt(admission, admission.thinkSubmissionId ?? ""),
  );
  const firstAdmission = admissions[0];
  const secondAdmission = admissions[1];
  if (firstAdmission === undefined || secondAdmission === undefined) {
    throw new Error("Expected activation admission fixtures");
  }
  const firstReceipt = receipts[0];
  if (firstReceipt === undefined) throw new Error("Expected activation receipt fixture");
  const { artifactChecksum: _artifactChecksum, ...firstReceiptContent } = firstReceipt;
  const missingCauseContent = { ...firstReceiptContent, cause: null, classification: null };
  expect(
    qualificationActivationAuthorityRecords({
      acceptedAdmissions: admissions,
      executionId: "execution-1",
      identities,
      planChecksum: "plan-1",
      receipts,
      region: "americas",
      runId: "run-1",
    }),
  ).toMatchObject({ _tag: "Ready", records: [{ rootId: "root-1" }, { rootId: "root-2" }] });

  expect(
    qualificationActivationAuthorityRecords({
      acceptedAdmissions: admissions,
      executionId: "execution-1",
      identities,
      planChecksum: "plan-1",
      receipts: [{ ...receipts[0], artifactChecksum: "corrupt" }, receipts[1]],
      region: "americas",
      runId: "run-1",
    }),
  ).toEqual({ _tag: "Conflict" });

  const swapped = [
    activationReceipt(firstAdmission, "submission-2"),
    activationReceipt(secondAdmission, "submission-1"),
  ];
  expect(
    qualificationActivationAuthorityRecords({
      acceptedAdmissions: admissions,
      executionId: "execution-1",
      identities,
      planChecksum: "plan-1",
      receipts: swapped,
      region: "americas",
      runId: "run-1",
    }),
  ).toEqual({ _tag: "Conflict" });

  expect(
    qualificationActivationAuthorityRecords({
      acceptedAdmissions: admissions,
      executionId: "execution-1",
      identities,
      planChecksum: "plan-1",
      receipts: [
        {
          ...missingCauseContent,
          artifactChecksum: qualificationChecksum(missingCauseContent),
        },
        receipts[1],
      ],
      region: "americas",
      runId: "run-1",
    }),
  ).toEqual({ _tag: "Missing" });
});

it("collects source bundles in canonical order and preserves closed and pending outcomes", async () => {
  const collected = new Array<string>();
  const pendingSource = "provider_delivery_receipts";
  const pending = await collectQualificationSourceBundle({
    collect: (source) => {
      collected.push(source);
      return Promise.resolve(
        source === pendingSource
          ? Response.json({ retryAtEpochMs: 42_000, source, status: "PENDING" }, { status: 202 })
          : Response.json({ recordCount: 0, source, status: "COMPLETE", streamChunkIndex: 7 }),
      );
    },
    streamChunkIndex: 7,
  });
  expect(pending.status).toBe(202);
  expect(await pending.json()).toEqual({
    pendingSources: [pendingSource],
    retryAtEpochMs: 42_000,
    status: "PENDING",
  });
  expect(collected).toEqual(qualificationAuthoritySources);

  collected.length = 0;
  const missingSource = "osfo_agent_activation_log";
  const missing = await collectQualificationSourceBundle({
    collect: (source) => {
      collected.push(source);
      return Promise.resolve(
        source === missingSource
          ? Response.json(
              { missingSources: [{ detail: "not installed", source }], status: "MISSING" },
              { status: 424 },
            )
          : Response.json({ recordCount: 1, source, status: "COMPLETE", streamChunkIndex: 7 }),
      );
    },
    streamChunkIndex: 7,
  });
  expect(missing.status).toBe(424);
  expect(collected).toEqual(
    qualificationAuthoritySources.slice(
      0,
      qualificationAuthoritySources.indexOf(missingSource) + 1,
    ),
  );

  const complete = await collectQualificationSourceBundle({
    collect: (source) =>
      Promise.resolve(
        Response.json({
          recordCount: qualificationAuthoritySources.indexOf(source),
          source,
          status: "COMPLETE",
          streamChunkIndex: 7,
        }),
      ),
    streamChunkIndex: 7,
  });
  expect(complete.status).toBe(200);
  expect(await complete.json()).toEqual({
    recordCounts: qualificationAuthoritySources.map((source, recordCount) => ({
      recordCount,
      source,
    })),
    status: "COMPLETE",
    streamChunkIndex: 7,
  });

  const substituted = await collectQualificationSourceBundle({
    collect: (source) =>
      Promise.resolve(
        Response.json({
          recordCount: 0,
          source:
            source === qualificationAuthoritySources[0] ? qualificationAuthoritySources[1] : source,
          status: "COMPLETE",
          streamChunkIndex: 7,
        }),
      ),
    streamChunkIndex: 7,
  });
  expect(substituted.status).toBe(409);
});

const activationAdmission = (attemptId: string, rootId: string, submissionId: string) => {
  const fact = {
    admissionDecision: "accepted" as const,
    agentId: AgentId.make("agent-1"),
    attemptId,
    executionId: "execution-1",
    planChecksum: "plan-1",
    rootId,
    runId: "run-1",
  };
  const productFactId = qualificationChecksum(fact);
  const content = {
    acceptanceReceiptId: productFactId,
    ...fact,
    occurredAt: "2026-08-29T17:00:00.000Z",
    productFactId,
    thinkSubmissionId: submissionId,
    userMessageId: submissionId,
    userUpdateId: productFactId,
  };
  return QualificationAdmissionReceipt.make({
    ...content,
    artifactChecksum: qualificationChecksum(content),
  });
};

const activationReceipt = (admission: QualificationAdmissionReceipt, requestId: string) => {
  const content = {
    activationId: "activation-1",
    attemptId: admission.attemptId,
    cause: "warm" as const,
    classification: "warm" as const,
    controllerOperationId: null,
    deploymentVersionId: "deployment-1",
    executionId: admission.executionId,
    occurredAt: admission.occurredAt,
    planChecksum: admission.planChecksum,
    productFactId: `activation:${admission.productFactId}`,
    region: "americas" as const,
    requestId,
    rootId: admission.rootId,
    runId: admission.runId,
    sessionId: "session-1",
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

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

it("refuses the first arrival before cohort access when the manifest has producer gaps", async () => {
  const manifest = createBoundedBetaManifest({
    dependencyVersions: {
      "@cloudflare/think": "0.15.1",
      agents: "0.20.1",
      effect: "4.0.0-rc.111",
    },
    hardLimits: [
      { maximum: 128, name: "workerMemory", unit: "MiB" },
      { maximum: 1_000, name: "workerSubrequests", unit: "requests" },
      { maximum: 250_000, name: "qualificationWorkflowSubrequests", unit: "requests" },
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
  const body = await response.json();
  expect(body).toMatchObject({ status: "MISSING" });
  expect(body).toMatchObject({
    missingSources: expect.arrayContaining([
      expect.objectContaining({ source: "osfo_agent_activation_log" }),
    ]),
  });
  expect(databaseRead).toBe(false);
});

it("refuses direct arrival execution when the frozen plan has known producer gaps", async () => {
  const manifest = createBoundedBetaManifest({
    dependencyVersions: {
      "@cloudflare/think": "0.15.1",
      agents: "0.20.1",
      effect: "4.0.0-rc.111",
    },
    hardLimits: [
      { maximum: 128, name: "workerMemory", unit: "MiB" },
      { maximum: 1_000, name: "workerSubrequests", unit: "requests" },
      { maximum: 250_000, name: "qualificationWorkflowSubrequests", unit: "requests" },
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

  const response = await handleQualificationProductAuthority(
    new Request("https://qualification-product-authority.internal/v1/executions/arrival-chunks", {
      body: invocation,
      method: "POST",
    }),
    env,
  );
  expect(response.status).toBe(424);
  expect(await response.json()).toMatchObject({
    missingSources: expect.arrayContaining([
      expect.objectContaining({ source: "osfo_agent_activation_log" }),
      expect.objectContaining({ source: "qualification_fault_controller_receipts" }),
      expect.objectContaining({ source: "whatsapp_delivery_receipts" }),
    ]),
    status: "MISSING",
  });
  expect(productEffectTouched).toBe(false);
  expect(authorityShardWrites).toBe(0);
  expect(
    retained.has(
      "qualification/executions/resume-test-execution/producer-authority/worker_admission_receipts/partitions/00000000/00000000.json",
    ),
  ).toBe(false);
  expect(
    retained.has(
      "qualification/executions/resume-test-execution/producer-authority/think_submission_receipts/partitions/00000000/00000000.json",
    ),
  ).toBe(false);
});

it("reads Worker and Think authority only from exact immutable producer shards", async () => {
  const manifest = createBoundedBetaManifest({
    dependencyVersions: {
      "@cloudflare/think": "0.15.1",
      agents: "0.20.1",
      effect: "4.0.0-rc.111",
    },
    hardLimits: [
      { maximum: 128, name: "workerMemory", unit: "MiB" },
      { maximum: 1_000, name: "workerSubrequests", unit: "requests" },
      { maximum: 250_000, name: "qualificationWorkflowSubrequests", unit: "requests" },
    ],
    sourceVersion: "readback-test-sha",
    topologyVersion: "cloudflare-v1",
    workloadSeed: 17,
  });
  const plan = createQualificationExecutionPlan(manifest, 0, "readback-test-execution");
  const run = plan.runs[0];
  if (run === undefined) throw new Error("The bounded plan must contain a run");
  const requestContent = {
    authoritySources: qualificationAuthoritySources,
    cohortArtifactChecksum: "cohort-checksum",
    cohortArtifactId: "qualification/executions/readback-test-execution/cohort/manifest.json",
    executionId: plan.executionId,
    manifest,
    manifestChecksum: manifest.manifestChecksum,
    plan,
    planChecksum: plan.planChecksum,
    protocolVersion: "qualification-owner-v1" as const,
    shardRecordLimit: 256 as const,
  };
  const requestArtifactChecksum = qualificationChecksum(requestContent);
  const requestArtifactId = "qualification/executions/readback-test-execution/owner-request.json";
  const retained = new Map<
    string,
    { readonly metadata: Record<string, string>; readonly value: string }
  >([
    [
      requestArtifactId,
      {
        metadata: {},
        value: canonicalQualificationJson({
          ...requestContent,
          artifactChecksum: requestArtifactChecksum,
        }),
      },
    ],
  ]);
  const bucket = {
    get: (key: string) => {
      const object = retained.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : {
              customMetadata: object.metadata,
              text: () => Promise.resolve(object.value),
            },
      );
    },
    list: (options: { limit: number; prefix: string }) => {
      const objects = [...retained.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .slice(0, options.limit)
        .map(([key, object]) => ({
          checksums: { toJSON: () => ({}) },
          customMetadata: object.metadata,
          key,
        }));
      return Promise.resolve({ objects, truncated: false as const });
    },
    put: (
      key: string,
      value: string,
      options: { readonly customMetadata: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { metadata: options.customMetadata, value });
      return Promise.resolve({});
    },
  };
  const arrivals = Array.from({ length: Math.min(256, run.arrivalCount) }, (_, index) => {
    const arrival = qualificationRunArrivalAt(manifest, run, index);
    if (arrival === undefined) throw new Error("Expected canonical arrival");
    return arrival;
  });
  const authorityArrivals = arrivals.map((arrival, index) => {
    const attemptId = qualificationChecksum({
      executionId: plan.executionId,
      planChecksum: plan.planChecksum,
      rootId: arrival.rootId,
      runId: run.runId,
    });
    const occurredAt = new Date(arrival.offeredAtEpochMs).toISOString();
    const agentId = AgentId.make("readback-agent");
    const productFactId = qualificationChecksum({
      admissionDecision: "accepted",
      agentId,
      attemptId,
      executionId: plan.executionId,
      planChecksum: plan.planChecksum,
      rootId: arrival.rootId,
      runId: run.runId,
    });
    const receiptContent = {
      acceptanceReceiptId: productFactId,
      admissionDecision: "accepted" as const,
      agentId,
      attemptId,
      executionId: plan.executionId,
      occurredAt,
      planChecksum: plan.planChecksum,
      productFactId,
      rootId: arrival.rootId,
      runId: run.runId,
      thinkSubmissionId: `submission-${index}`,
      userMessageId: `message-${index}`,
      userUpdateId: productFactId,
    };
    return {
      admissionReceipt: {
        ...receiptContent,
        artifactChecksum: qualificationChecksum(receiptContent),
      },
      arrival,
      attemptId,
      authorityFactId: receiptContent.productFactId,
      executedAtUtc: occurredAt,
      executionId: plan.executionId,
      rootId: arrival.rootId,
      submittedAtUtc: occurredAt,
    };
  });
  const arrivalBody = {
    chunkIndex: 0,
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    previousArtifactChecksum: "NONE",
    records: authorityArrivals,
    runId: run.runId,
    streamChunkIndex: 0,
  };
  retained.set(
    "qualification/executions/readback-test-execution/authority-streams/arrivals/partitions/00000000/00000000.json",
    {
      metadata: {},
      value: canonicalQualificationJson({
        ...arrivalBody,
        bodyChecksum: qualificationChecksum(arrivalBody),
      }),
    },
  );
  const workerRecords = authorityArrivals.map(({ admissionReceipt: receipt }) => ({
    acceptanceReceiptId: receipt.acceptanceReceiptId,
    admissionDecision: receipt.admissionDecision,
    effectReceipts: [],
    occurredAt: receipt.occurredAt,
    productFactId: receipt.productFactId,
    rootId: receipt.rootId,
    stageOccurrences: [
      {
        boundary: "durableAcceptanceCommitted" as const,
        occurredAt: receipt.occurredAt,
        productFactId: receipt.productFactId,
      },
    ],
    usageFacts: [],
    userMessageId: receipt.userMessageId,
    userUpdateId: receipt.userUpdateId,
  }));
  const thinkRecords = authorityArrivals.map(({ admissionReceipt: receipt }) => ({
    acceptanceReceiptId: receipt.acceptanceReceiptId,
    effectReceipts: [
      { effectId: receipt.thinkSubmissionId ?? "", kind: "thinkSubmissions" as const },
    ],
    occurredAt: receipt.occurredAt,
    productFactId: qualificationChecksum({
      acceptanceReceiptId: receipt.acceptanceReceiptId,
      source: "think_submission_receipts",
      thinkSubmissionId: receipt.thinkSubmissionId,
    }),
    rootId: receipt.rootId,
    stageOccurrences: [],
    submissionStatus: "accepted" as const,
    thinkSubmissionId: receipt.thinkSubmissionId ?? "",
    usageFacts: [],
  }));
  for (const [source, records] of [
    ["worker_admission_receipts", workerRecords],
    ["think_submission_receipts", thinkRecords],
  ] as const) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The two canonical producer shards are retained in source order.
    await expect(
      retainQualificationProductAuthorityShard({
        bucket,
        executionId: plan.executionId,
        planChecksum: plan.planChecksum,
        records,
        source,
        sourceVersion: manifest.sourceVersion,
        startsAtEpochMs: plan.startsAtEpochMs,
        streamChunkIndex: 0,
      }),
    ).resolves.toBe(true);
  }
  const requestFor = (source: "think_submission_receipts" | "worker_admission_receipts") =>
    new Request("https://qualification-product-authority.internal/v1/executions/source-chunks", {
      body: canonicalQualificationJson({
        chunkIndex: 0,
        executionId: plan.executionId,
        manifestChecksum: manifest.manifestChecksum,
        planChecksum: plan.planChecksum,
        requestArtifactChecksum,
        requestArtifactId,
        runId: run.runId,
        source,
      }),
      method: "POST",
    });

  for (const source of ["worker_admission_receipts", "think_submission_receipts"] as const) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Both readback adapters are asserted independently.
    const response = await handleQualificationProductAuthority(requestFor(source), {
      ARTIFACTS: bucket,
      DB: { connectionString: "postgres://must-not-be-read.invalid/osfo" },
    });
    expect(response.status).toBe(200);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Response identity is checked beside its source request.
    expect(await response.json()).toEqual({
      recordCount: arrivals.length,
      source,
      status: "COMPLETE",
      streamChunkIndex: 0,
    });
  }

  const workerKey = [...retained.keys()].find((key) =>
    key.includes("producer-authority/worker_admission_receipts"),
  );
  if (workerKey === undefined) throw new Error("Expected retained Worker authority");
  const worker = retained.get(workerKey);
  if (worker === undefined) throw new Error("Expected retained Worker authority bytes");
  retained.delete(workerKey);
  const missing = await handleQualificationProductAuthority(
    requestFor("worker_admission_receipts"),
    { ARTIFACTS: bucket, DB: { connectionString: "postgres://must-not-be-read.invalid/osfo" } },
  );
  expect(missing.status).toBe(424);
  retained.set(workerKey, {
    ...worker,
    value: worker.value.replace(
      '"admissionDecision":"accepted"',
      '"admissionDecision":"capacityRejected"',
    ),
  });
  const spliced = await handleQualificationProductAuthority(
    requestFor("worker_admission_receipts"),
    { ARTIFACTS: bucket, DB: { connectionString: "postgres://must-not-be-read.invalid/osfo" } },
  );
  expect(spliced.status).toBe(409);
  retained.set(workerKey, {
    ...worker,
    metadata: { ...worker.metadata, "osfo-plan-checksum": "substituted-plan" },
  });
  const tampered = await handleQualificationProductAuthority(
    requestFor("worker_admission_receipts"),
    { ARTIFACTS: bucket, DB: { connectionString: "postgres://must-not-be-read.invalid/osfo" } },
  );
  expect(tampered.status).toBe(409);
  retained.set(workerKey, worker);
  retained.set(`${workerKey}.extra`, worker);
  const extra = await handleQualificationProductAuthority(requestFor("worker_admission_receipts"), {
    ARTIFACTS: bucket,
    DB: { connectionString: "postgres://must-not-be-read.invalid/osfo" },
  });
  expect(extra.status).toBe(409);
  retained.delete(`${workerKey}.extra`);
  const thinkKey = [...retained.keys()].find((key) =>
    key.includes("producer-authority/think_submission_receipts"),
  );
  if (thinkKey === undefined) throw new Error("Expected retained Think authority");
  retained.delete(thinkKey);
  const substitutedThinkRecords = thinkRecords.map((record, index) => {
    if (index > 0) return record;
    const thinkSubmissionId = "substituted-submission";
    return Object.assign({}, record, {
      effectReceipts: [{ effectId: thinkSubmissionId, kind: "thinkSubmissions" as const }],
      productFactId: qualificationChecksum({
        acceptanceReceiptId: record.acceptanceReceiptId,
        source: "think_submission_receipts",
        thinkSubmissionId,
      }),
      thinkSubmissionId,
    });
  });
  await expect(
    retainQualificationProductAuthorityShard({
      bucket,
      executionId: plan.executionId,
      planChecksum: plan.planChecksum,
      records: substitutedThinkRecords,
      source: "think_submission_receipts",
      sourceVersion: manifest.sourceVersion,
      startsAtEpochMs: plan.startsAtEpochMs,
      streamChunkIndex: 0,
    }),
  ).resolves.toBe(true);
  const substituted = await handleQualificationProductAuthority(
    requestFor("think_submission_receipts"),
    { ARTIFACTS: bucket, DB: { connectionString: "postgres://must-not-be-read.invalid/osfo" } },
  );
  expect(substituted.status).toBe(409);
});

it("reads controlled Agent fault authority only from exact retained recovery and source facts", async () => {
  const manifest = createBoundedBetaManifest({
    dependencyVersions: {
      "@cloudflare/think": "0.15.1",
      agents: "0.20.1",
      effect: "4.0.0-rc.111",
    },
    hardLimits: [
      { maximum: 128, name: "workerMemory", unit: "MiB" },
      { maximum: 1_000, name: "workerSubrequests", unit: "requests" },
      { maximum: 250_000, name: "qualificationWorkflowSubrequests", unit: "requests" },
    ],
    sourceVersion: "controlled-fault-readback-sha",
    topologyVersion: "cloudflare-v1",
    workloadSeed: 17,
  });
  const plan = createQualificationExecutionPlan(manifest, 0, "controlled-fault-readback");
  const run = plan.runs.find(
    (candidate) => candidate.kind === "challenge" && candidate.challenge === "coldActivation",
  );
  if (run === undefined) throw new Error("Expected the frozen cold-activation challenge");
  const arrival = qualificationRunArrivalAt(manifest, run, 0);
  if (arrival === undefined) throw new Error("Expected the frozen cold-activation arrival");
  const context = {
    attemptId: qualificationChecksum({
      executionId: plan.executionId,
      planChecksum: plan.planChecksum,
      rootId: arrival.rootId,
      runId: run.runId,
    }),
    executionId: plan.executionId,
    journey: "journey" in arrival ? arrival.journey : ("ordinaryConversation" as const),
    offeredAtEpochMs: arrival.offeredAtEpochMs,
    planChecksum: plan.planChecksum,
    region: run.region,
    rootId: arrival.rootId,
    runId: run.runId,
  };
  const operationId = qualificationControlledAgentAbortOperationId(context);
  const offeredAtUtc = new Date(arrival.offeredAtEpochMs).toISOString();
  const recovery = qualificationControlledAgentRecoveryReceipt({
    applicationAuthorityFactId: "facet-abort-applied",
    appliedAtUtc: new Date(arrival.offeredAtEpochMs - 2).toISOString(),
    armedActivationId: "activation-before-abort",
    controllerOperationId: operationId,
    executionId: plan.executionId,
    manifestChecksum: manifest.manifestChecksum,
    planChecksum: plan.planChecksum,
    recoveredActivationId: "activation-after-abort",
    recoveredAtUtc: new Date(arrival.offeredAtEpochMs - 1).toISOString(),
    rootId: arrival.rootId,
    runId: run.runId,
  });
  const faultReceipt = qualificationControlledAgentFaultReceipt({
    manifestChecksum: manifest.manifestChecksum,
    receipt: recovery,
    scheduledTriggerAtUtc: new Date(run.startsAtEpochMs).toISOString(),
  });
  const requestContent = {
    authoritySources: qualificationAuthoritySources,
    cohortArtifactChecksum: "cohort-checksum",
    cohortArtifactId: `qualification/executions/${plan.executionId}/cohort/manifest.json`,
    executionId: plan.executionId,
    manifest,
    manifestChecksum: manifest.manifestChecksum,
    plan,
    planChecksum: plan.planChecksum,
    protocolVersion: "qualification-owner-v1" as const,
    shardRecordLimit: 256 as const,
  };
  const requestArtifactChecksum = qualificationChecksum(requestContent);
  const requestArtifactId = `qualification/executions/${plan.executionId}/owner-request.json`;
  const retained = new Map<
    string,
    { readonly metadata: Record<string, string>; readonly value: string }
  >([
    [
      requestArtifactId,
      {
        metadata: {},
        value: canonicalQualificationJson({
          ...requestContent,
          artifactChecksum: requestArtifactChecksum,
        }),
      },
    ],
  ]);
  const bucket = {
    get: (key: string) => {
      const object = retained.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : { customMetadata: object.metadata, text: () => Promise.resolve(object.value) },
      );
    },
    list: (options: { limit: number; prefix: string }) =>
      Promise.resolve({
        objects: [...retained.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .slice(0, options.limit)
          .map(([key, object]) => ({
            checksums: { toJSON: () => ({}) },
            customMetadata: object.metadata,
            key,
          })),
        truncated: false as const,
      }),
    put: (
      key: string,
      value: string,
      options: { readonly customMetadata: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { metadata: options.customMetadata, value });
      return Promise.resolve({});
    },
  };
  const recoveryArtifactId = faultReceipt.artifactId;
  const recoveryEncoded = canonicalQualificationJson(recovery);
  retained.set(recoveryArtifactId, {
    metadata: {
      "osfo-artifact-checksum": recovery.artifactChecksum,
      "osfo-body-sha256": await sha256Hex(recoveryEncoded),
      "osfo-controller-operation-id": operationId,
      "osfo-execution-id": plan.executionId,
      "osfo-kind": "qualification-controlled-agent-recovery-v1",
      "osfo-plan-checksum": plan.planChecksum,
      "osfo-root-id": arrival.rootId,
      "osfo-run-id": run.runId,
    },
    value: recoveryEncoded,
  });
  await retainQualificationProductAuthorityShard({
    bucket,
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    records: [faultReceipt],
    source: "qualification_fault_controller_receipts",
    sourceVersion: manifest.sourceVersion,
    startsAtEpochMs: plan.startsAtEpochMs,
    streamChunkIndex: plan.runs
      .slice(0, plan.runs.indexOf(run))
      .reduce((count, candidate) => count + Math.ceil(candidate.arrivalCount / 256), 0),
  });
  const invocation = canonicalQualificationJson({
    chunkIndex: 0,
    executionId: plan.executionId,
    manifestChecksum: manifest.manifestChecksum,
    planChecksum: plan.planChecksum,
    requestArtifactChecksum,
    requestArtifactId,
    runId: run.runId,
    source: "qualification_fault_controller_receipts",
  });
  const collect = () =>
    handleQualificationProductAuthority(
      new Request("https://qualification-product-authority.internal/v1/executions/source-chunks", {
        body: invocation,
        method: "POST",
      }),
      { ARTIFACTS: bucket, DB: { connectionString: "postgres://unused.invalid/osfo" } },
    );

  await expect(collect()).resolves.toMatchObject({ status: 200 });
  retained.delete(recoveryArtifactId);
  const missing = await collect();
  expect(missing.status).toBe(424);
  expect(await missing.json()).toMatchObject({ status: "MISSING" });
  retained.set(recoveryArtifactId, {
    metadata: {
      "osfo-artifact-checksum": recovery.artifactChecksum,
      "osfo-body-sha256": "tampered",
      "osfo-controller-operation-id": operationId,
      "osfo-execution-id": plan.executionId,
      "osfo-kind": "qualification-controlled-agent-recovery-v1",
      "osfo-plan-checksum": plan.planChecksum,
      "osfo-root-id": arrival.rootId,
      "osfo-run-id": run.runId,
    },
    value: recoveryEncoded,
  });
  await expect(collect()).resolves.toMatchObject({ status: 409 });
  expect(offeredAtUtc).toBe(new Date(arrival.offeredAtEpochMs).toISOString());
});
