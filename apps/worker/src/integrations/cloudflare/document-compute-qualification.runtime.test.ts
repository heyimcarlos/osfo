/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Assertions execute inside Effect tests against real workerd R2; retained outcomes use _tag. */
import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { DocumentBuild } from "../../services/document-build";
import { DocumentIntentDigest, DocumentSource } from "../../services/document-generation";
import {
  makeAttemptEvidenceStore,
  makeWithSandbox,
  settleAttemptEvidenceForTerminalCleanup,
  transitionQualificationAttemptEvidence,
} from "./document-compute";
import { attemptKeyFor, ownerKeyFor } from "./document-storage-keys";

const contentId = ContentId.make("document:workflow:qualification-compute-runtime");
const workflowId = DocumentBuild.WorkflowId.make("qualification-compute-runtime");
const userId = UserId.make("qualification-compute-runtime-user");
const intentDigest = DocumentIntentDigest.make("d".repeat(64));
const cost = {
  _tag: "Incurred" as const,
  allowancePeriodId: AllowancePeriodId.make("qualification-compute-runtime-period"),
  basis: "conservative" as const,
  providerOperationId: "qualification-compute-runtime-provider-operation",
  usdMicros: 50_000n,
};
const context = {
  attemptId: "qualification-compute-runtime-attempt",
  executionId: "qualification-compute-runtime-execution",
  journey: "documentBuild" as const,
  offeredAtEpochMs: 1_788_000_000_000,
  planChecksum: "qualification-compute-runtime-plan",
  region: "americas" as const,
  rootId: "qualification-compute-runtime-root",
  runId: "qualification-compute-runtime-run",
};

it.effect(
  "retains exact qualification identity through claimed, started, and completed CAS states",
  () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        env.ARTIFACTS.delete([attemptKeyFor(contentId), ownerKeyFor(userId, contentId)]),
      );
      const store = makeAttemptEvidenceStore(env.ARTIFACTS);
      const claimed = yield* Effect.promise(() =>
        store.claim(contentId, intentDigest, cost, 1_788_000_600_000, userId, {
          claimedAtEpochMs: 1_788_000_000_010,
          context,
          workflowId,
        }),
      );
      if (claimed._tag !== "Claimed") throw new Error("Expected qualification attempt claim");
      expect(claimed.evidence.qualification).toMatchObject({
        claimedAtEpochMs: 1_788_000_000_010,
        completedAtEpochMs: null,
        contentId,
        context,
        evidenceVersion: "document-compute-attempt-v2",
        failedAtEpochMs: null,
        startedAtEpochMs: null,
        taskExecutionId: `document-compute:${contentId}`,
        taskOutcomeId: null,
        workflowId,
      });
      expect(claimed.evidence.qualification?.artifactChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);

      const replay = yield* Effect.promise(() =>
        store.claim(
          contentId,
          intentDigest,
          { ...cost, providerOperationId: "retry-proposal-is-not-authority" },
          1_788_000_700_000,
          userId,
          { claimedAtEpochMs: 1_788_000_000_020, context, workflowId },
        ),
      );
      expect(replay).toMatchObject({
        _tag: "Claimed",
        created: false,
        evidence: claimed.evidence,
      });

      const startedEvidence = transitionQualificationAttemptEvidence(
        { ...claimed.evidence, status: "started" },
        { startedAtEpochMs: 1_788_000_000_100 },
      );
      const startedRevision = yield* Effect.promise(() =>
        store.start(contentId, startedEvidence, claimed.revision),
      );
      if (startedRevision === null) throw new Error("Expected qualification attempt start");
      const completedEvidence = transitionQualificationAttemptEvidence(
        { ...startedEvidence, renderedPageCount: 1, status: "completed" },
        { completedAtEpochMs: 1_788_000_000_200 },
      );
      expect(
        yield* Effect.promise(() => store.complete(contentId, completedEvidence, startedRevision)),
      ).toBe(true);
      expect(yield* Effect.promise(() => store.inspect(contentId))).toEqual(completedEvidence);

      const encoded = (yield* Effect.promise(() => env.ARTIFACTS.head(attemptKeyFor(contentId))))
        ?.customMetadata?.osfo;
      expect(encoded).toBeDefined();
      expect(encoded).toContain(completedEvidence.qualification?.artifactChecksum);
    }),
);

it.effect("rejects qualification substitution and malformed retained checksums", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      env.ARTIFACTS.delete([attemptKeyFor(contentId), ownerKeyFor(userId, contentId)]),
    );
    const store = makeAttemptEvidenceStore(env.ARTIFACTS);
    const claimed = yield* Effect.promise(() =>
      store.claim(contentId, intentDigest, cost, 1_788_000_600_000, userId, {
        claimedAtEpochMs: 1_788_000_000_010,
        context,
        workflowId,
      }),
    );
    if (claimed._tag !== "Claimed") throw new Error("Expected qualification attempt claim");
    expect(
      yield* Effect.promise(() =>
        store.claim(contentId, intentDigest, cost, 1_788_000_600_000, userId, {
          claimedAtEpochMs: 1_788_000_000_010,
          context: { ...context, rootId: "substituted-root" },
          workflowId,
        }),
      ),
    ).toEqual({ _tag: "IntentConflict" });

    const object = yield* Effect.promise(() => env.ARTIFACTS.head(attemptKeyFor(contentId)));
    const encoded = object?.customMetadata?.osfo;
    if (object === null || encoded === undefined) throw new Error("Expected retained attempt");
    yield* Effect.promise(() =>
      env.ARTIFACTS.put(attemptKeyFor(contentId), new Uint8Array(), {
        customMetadata: {
          osfo: encoded.replace(
            claimed.evidence.qualification?.artifactChecksum ?? "",
            `sha256:${"0".repeat(64)}`,
          ),
        },
        onlyIf: { etagMatches: object.etag },
      }),
    );
    yield* Effect.promise(() =>
      expect(store.inspect(contentId)).rejects.toThrow(
        "Qualification document attempt checksum does not match its retained body",
      ),
    );
  }),
);

it.effect("retains a producer-owned terminal compute failure without repeating work", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      env.ARTIFACTS.delete([attemptKeyFor(contentId), ownerKeyFor(userId, contentId)]),
    );
    const store = makeAttemptEvidenceStore(env.ARTIFACTS);
    const claimed = yield* Effect.promise(() =>
      store.claim(contentId, intentDigest, cost, 1_788_000_600_000, userId, {
        claimedAtEpochMs: 1_788_000_000_010,
        context,
        workflowId,
      }),
    );
    if (claimed._tag !== "Claimed") throw new Error("Expected qualification attempt claim");
    const startedEvidence = transitionQualificationAttemptEvidence(
      { ...claimed.evidence, status: "started" },
      { startedAtEpochMs: 1_788_000_000_100 },
    );
    const startedRevision = yield* Effect.promise(() =>
      store.start(contentId, startedEvidence, claimed.revision),
    );
    if (startedRevision === null) throw new Error("Expected qualification attempt start");
    const failedEvidence = transitionQualificationAttemptEvidence(
      { ...startedEvidence, status: "failed" },
      { failedAtEpochMs: 1_788_000_000_200 },
    );
    expect(
      yield* Effect.promise(() => store.fail(contentId, failedEvidence, startedRevision)),
    ).toBe(true);
    expect(yield* Effect.promise(() => store.inspect(contentId))).toEqual(failedEvidence);
    expect(
      yield* Effect.promise(() =>
        store.claim(contentId, intentDigest, cost, 1_788_000_700_000, userId, {
          claimedAtEpochMs: 1_788_000_000_300,
          context,
          workflowId,
        }),
      ),
    ).toEqual({ _tag: "Terminal", evidence: failedEvidence });
  }),
);

it.effect("writes terminal failure from the real Document Compute execution boundary", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      env.ARTIFACTS.delete([attemptKeyFor(contentId), ownerKeyFor(userId, contentId)]),
    );
    const store = makeAttemptEvidenceStore(env.ARTIFACTS);
    const compute = makeWithSandbox(
      () => ({
        destroy: () => Promise.resolve(),
        exec: () => Promise.resolve({ exitCode: 1, stdout: "", success: false }),
        exists: () => Promise.resolve({ exists: false }),
        readStream: () => Promise.resolve({ content: new ReadableStream<Uint8Array>(), size: 0 }),
        readText: () => Promise.resolve(""),
        writeFile: () => Promise.resolve(),
      }),
      store,
      50_000n,
    );
    expect(
      yield* compute.generate({
        allowancePeriodId: cost.allowancePeriodId,
        authorizeWrite: Effect.void,
        contentId,
        format: "pdf",
        intentDigest,
        qualification: { context, workflowId },
        source: DocumentSource.make({ pages: [{ lines: ["qualification"], title: "Title" }] }),
        supportingVisuals: [],
        userId,
      }),
    ).toMatchObject({ _tag: "Interrupted", cost: { _tag: "Incurred" } });
    expect(yield* Effect.promise(() => store.inspect(contentId))).toMatchObject({
      qualification: {
        context,
        taskOutcomeId: `document-compute:${contentId}:failed`,
        workflowId,
      },
      status: "failed",
    });
  }),
);

it.effect("retains an explicit no-compute obligation instead of inferring it from absence", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      env.ARTIFACTS.delete([attemptKeyFor(contentId), ownerKeyFor(userId, contentId)]),
    );
    expect(
      yield* settleAttemptEvidenceForTerminalCleanup(env.ARTIFACTS, contentId, userId, {
        claimedAtEpochMs: 1_788_000_000_010,
        context,
        intentDigest,
        workflowId,
      }),
    ).toBe("notRequired");
    expect(
      yield* Effect.promise(() => makeAttemptEvidenceStore(env.ARTIFACTS).inspect(contentId)),
    ).toMatchObject({
      cost: { _tag: "ProvenNoUse" },
      intentDigest,
      qualification: {
        context,
        taskExecutionId: `document-compute:${contentId}`,
        taskOutcomeId: `document-compute:${contentId}:not-required`,
        workflowId,
      },
      status: "notRequired",
      userId,
    });
    expect(
      yield* settleAttemptEvidenceForTerminalCleanup(env.ARTIFACTS, contentId, userId, {
        claimedAtEpochMs: 1_788_000_000_020,
        context,
        intentDigest,
        workflowId,
      }),
    ).toBe("notRequired");
    expect(
      yield* Effect.promise(() =>
        makeAttemptEvidenceStore(env.ARTIFACTS).claim(
          contentId,
          intentDigest,
          cost,
          1_788_000_600_000,
          userId,
          { claimedAtEpochMs: 1_788_000_000_030, context, workflowId },
        ),
      ),
    ).toMatchObject({ _tag: "Terminal", evidence: { status: "notRequired" } });
  }),
);

it.effect("preserves an existing qualification claim during terminal cleanup", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      env.ARTIFACTS.delete([attemptKeyFor(contentId), ownerKeyFor(userId, contentId)]),
    );
    const store = makeAttemptEvidenceStore(env.ARTIFACTS);
    const claimed = yield* Effect.promise(() =>
      store.claim(contentId, intentDigest, cost, 1_788_000_600_000, userId, {
        claimedAtEpochMs: 1_788_000_000_010,
        context,
        workflowId,
      }),
    );
    if (claimed._tag !== "Claimed") throw new Error("Expected qualification attempt claim");
    expect(
      yield* settleAttemptEvidenceForTerminalCleanup(env.ARTIFACTS, contentId, userId, {
        claimedAtEpochMs: 1_788_000_000_200,
        context,
        intentDigest,
        workflowId,
      }),
    ).toBe("preserved");
    expect(yield* Effect.promise(() => store.inspect(contentId))).toEqual(claimed.evidence);
    expect(
      yield* Effect.promise(() => env.ARTIFACTS.head(ownerKeyFor(userId, contentId))),
    ).not.toBeNull();
  }),
);
