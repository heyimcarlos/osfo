/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect Vitest generators. */
import { expect, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber } from "effect";

import { compactManifest } from "../../../test/support/qualification-fixtures";
import {
  createQualificationExecutionPlan,
  qualificationRunArrivals,
  type QualificationArrivalAttempt,
  type QualificationFaultAttempt,
} from "../../qualification/execution";
import { qualificationChecksum } from "../../qualification/qualification-checksum";
import type { QualificationExecutionBucket } from "./qualification-execution-artifacts";
import {
  makeQualificationArrivalExecutor,
  makeQualificationFaultExecutor,
  QualificationArrivalAuthorityUnavailable,
  type IdempotentQualificationArrivalAuthority,
  type IdempotentQualificationFaultController,
} from "./qualification-authority-execution";

const fixture = () => {
  const manifest = compactManifest();
  const plan = createQualificationExecutionPlan(manifest, 0, "arrival-authority-test");
  const run = plan.runs[0];
  if (run === undefined) throw new Error("Expected a qualification run");
  const arrival = qualificationRunArrivals(manifest, run).next();
  if (arrival.done) throw new Error("Expected a qualification arrival");
  const attemptContent = {
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    rootId: arrival.value.rootId,
    runId: run.runId,
  };
  const attempt = {
    ...attemptContent,
    attemptId: `attempt-${arrival.value.rootId}`,
  } satisfies QualificationArrivalAttempt;
  return { arrival: arrival.value, attempt, manifest, run };
};

const bucketStub = () => {
  const objects = new Map<string, string>();
  const options: Array<Parameters<QualificationExecutionBucket["put"]>[2]> = [];
  let failNextCompletionWrite = false;
  const bucket = {
    get: (key: string) => {
      const value = objects.get(key);
      return Promise.resolve(value === undefined ? null : { text: () => Promise.resolve(value) });
    },
    put: (
      key: string,
      value: string,
      writeOptions: Parameters<QualificationExecutionBucket["put"]>[2],
    ) => {
      options.push(writeOptions);
      if (failNextCompletionWrite && key.endsWith("/completion.json")) {
        failNextCompletionWrite = false;
        return Promise.reject(new Error("injected completion write failure"));
      }
      if (objects.has(key)) return Promise.resolve(null);
      objects.set(key, value);
      return Promise.resolve({ etag: `etag-${key}` });
    },
  } satisfies QualificationExecutionBucket;
  return {
    bucket,
    failCompletionWriteOnce: () => {
      failNextCompletionWrite = true;
    },
    objects,
    options,
  };
};

const authorityFixture = (behavior: "normal" | "failBeforeEffect" | "unknown" = "normal") => {
  const applied = new Map<string, ReturnType<typeof recordFor>>();
  let effects = 0;
  let failBeforeEffect = behavior === "failBeforeEffect";
  const authority: IdempotentQualificationArrivalAuthority<"injected"> = {
    executeIdempotent: (_manifest, _run, arrival, attempt) => {
      if (failBeforeEffect) {
        failBeforeEffect = false;
        return Effect.fail("injected");
      }
      return Effect.sync(() => {
        const existing = applied.get(attempt.attemptId);
        if (existing !== undefined) return existing;
        effects += 1;
        const record = recordFor(attempt, arrival.rootId, arrival.offeredAtEpochMs);
        applied.set(attempt.attemptId, record);
        return record;
      });
    },
    reconcile: (attempt) => {
      if (behavior === "unknown") return Effect.succeed({ outcome: "Unknown" });
      const record = applied.get(attempt.attemptId);
      return Effect.succeed(
        record === undefined
          ? ({ outcome: "NotApplied" } as const)
          : ({ outcome: "Applied", record } as const),
      );
    },
  };
  return { authority, effectCount: () => effects };
};

const recordFor = (
  attempt: QualificationArrivalAttempt,
  rootId: string,
  offeredAtEpochMs: number,
) =>
  ({
    attemptId: attempt.attemptId,
    authorityFactId: `product-fact-${rootId}`,
    executedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(offeredAtEpochMs + 1)),
    executionId: attempt.executionId,
    rootId,
    submittedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(offeredAtEpochMs)),
  }) as const;

it.effect("reconciles a crash after product commit without replaying the authority effect", () =>
  Effect.gen(function* () {
    const input = fixture();
    const storage = bucketStub();
    const product = authorityFixture();
    const execute = makeQualificationArrivalExecutor(storage.bucket, product.authority);
    storage.failCompletionWriteOnce();

    expect(
      yield* Effect.flip(execute(input.manifest, input.run, input.arrival, input.attempt)),
    ).toBeInstanceOf(QualificationArrivalAuthorityUnavailable);
    const reconciled = yield* execute(input.manifest, input.run, input.arrival, input.attempt);

    expect(reconciled.authorityFactId).toBe(`product-fact-${input.arrival.rootId}`);
    expect(product.effectCount()).toBe(1);
    expect(storage.options.every((option) => option.onlyIf.etagDoesNotMatch === "*")).toBe(true);
  }),
);

it.effect("retries only after authority proves the claimed attempt was not applied", () =>
  Effect.gen(function* () {
    const input = fixture();
    const storage = bucketStub();
    const product = authorityFixture("failBeforeEffect");
    const execute = makeQualificationArrivalExecutor(storage.bucket, product.authority);

    expect(
      yield* Effect.flip(execute(input.manifest, input.run, input.arrival, input.attempt)),
    ).toBe("injected");
    yield* execute(input.manifest, input.run, input.arrival, input.attempt);

    expect(product.effectCount()).toBe(1);
  }),
);

it.effect("refuses an ambiguous claimed attempt instead of blindly executing it", () =>
  Effect.gen(function* () {
    const input = fixture();
    const storage = bucketStub();
    const initial = authorityFixture("failBeforeEffect");
    const executeInitial = makeQualificationArrivalExecutor(storage.bucket, initial.authority);
    yield* Effect.flip(executeInitial(input.manifest, input.run, input.arrival, input.attempt));

    const ambiguous = authorityFixture("unknown");
    const executeAmbiguous = makeQualificationArrivalExecutor(storage.bucket, ambiguous.authority);
    const failure = yield* Effect.flip(
      executeAmbiguous(input.manifest, input.run, input.arrival, input.attempt),
    );

    expect(failure).toBeInstanceOf(QualificationArrivalAuthorityUnavailable);
    expect(ambiguous.effectCount()).toBe(0);
  }),
);

it.effect("deduplicates concurrent calls through the stable product attempt key", () =>
  Effect.gen(function* () {
    const input = fixture();
    const storage = bucketStub();
    const product = authorityFixture();
    const execute = makeQualificationArrivalExecutor(storage.bucket, product.authority);

    const results = yield* Effect.all(
      [
        execute(input.manifest, input.run, input.arrival, input.attempt),
        execute(input.manifest, input.run, input.arrival, input.attempt),
      ],
      { concurrency: "unbounded" },
    );

    expect(results[0]).toEqual(results[1]);
    expect(product.effectCount()).toBe(1);
  }),
);

it.effect("waits for the frozen product-state trigger and deduplicates fault application", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, 0, "fault-authority-test");
    const run = plan.runs.find(
      (candidate) =>
        candidate.fault !== null &&
        !["beforeOffer", "sharedDueTime", "startOfFaultWindow", "startOfOfferWindow"].includes(
          candidate.fault.trigger,
        ),
    );
    if (run === undefined || run.fault === null) throw new Error("Expected state-triggered fault");
    const scheduledTriggerAtUtc = DateTime.formatIso(DateTime.makeUnsafe(run.startsAtEpochMs));
    const attemptContent = {
      executionId: plan.executionId,
      planChecksum: plan.planChecksum,
      requiresAuthorityFact: true,
      runId: run.runId,
      scheduledTriggerAtUtc,
    };
    const attempt = {
      ...attemptContent,
      attemptId: qualificationChecksum(attemptContent),
    } satisfies QualificationFaultAttempt;
    const trigger = yield* Deferred.make<string>();
    let effects = 0;
    let retainedReceipt: ReturnType<typeof faultReceiptFor> | undefined;
    const controller: IdempotentQualificationFaultController<never> = {
      applyIdempotent: (_manifest, _plan, _run, fault, frozenAttempt) =>
        Effect.gen(function* () {
          const authorityFactId = yield* Deferred.await(trigger);
          effects += 1;
          const receipt = faultReceiptFor(frozenAttempt, fault, authorityFactId);
          retainedReceipt = receipt;
          return receipt;
        }),
      reconcile: () =>
        Effect.succeed(
          retainedReceipt === undefined
            ? ({ outcome: "NotApplied" } as const)
            : ({ outcome: "Applied", receipt: retainedReceipt } as const),
        ),
    };
    const execute = makeQualificationFaultExecutor(bucketStub().bucket, controller);
    const first = yield* execute(manifest, plan, run, run.fault, attempt).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(effects).toBe(0);
    yield* Deferred.succeed(trigger, "accepted-root-authority-fact");
    const receipt = yield* Fiber.join(first);
    const replay = yield* execute(manifest, plan, run, run.fault, attempt);

    expect(receipt.triggerAuthorityFactId).toBe("accepted-root-authority-fact");
    expect(replay).toEqual(receipt);
    expect(effects).toBe(1);
  }),
);

const faultReceiptFor = (
  attempt: QualificationFaultAttempt,
  fault: NonNullable<ReturnType<typeof compactManifest>["faults"][number]>,
  triggerAuthorityFactId: string,
) => {
  const content = {
    applicationStatus: "applied" as const,
    artifactId: `fault-${attempt.attemptId}`,
    controllerOperationId: `operation-${attempt.attemptId}`,
    controllerSource: "test-product-fault-controller",
    durationSeconds: fault.durationSeconds,
    endedAtUtc: DateTime.formatIso(
      DateTime.makeUnsafe(
        Date.parse(attempt.scheduledTriggerAtUtc) + fault.durationSeconds * 1_000,
      ),
    ),
    executionId: attempt.executionId,
    injectedAtUtc: attempt.scheduledTriggerAtUtc,
    kind: fault.kind,
    manifestChecksum: compactManifest().manifestChecksum,
    planChecksum: attempt.planChecksum,
    runId: attempt.runId,
    scheduledTriggerAtUtc: attempt.scheduledTriggerAtUtc,
    target: fault.target,
    trigger: fault.trigger,
    triggerAuthorityFactId,
    triggerObservedAtUtc: attempt.scheduledTriggerAtUtc,
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};
