/* oxlint-disable vitest/no-standalone-expect, effecttsgo/async-function, effecttsgo/global-date -- Assertions run in Effects; Promise ports and fixed lease dates model Cloudflare/PG boundaries. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import type {
  QualificationCohortScrubDispatchClaim,
  QualificationCohortScrubDispatchMutation,
  QualificationCohortScrubRestartReservation,
} from "../integrations/postgres/qualification-cohort-scrub-dispatch";
import { qualificationCohortScrubDispatchIdentity } from "../qualification/cohort-scrub-dispatch";
import {
  type QualificationCohortScrubDispatchInstance,
  type QualificationCohortScrubDispatchPorts,
  reconcileQualificationCohortScrubDispatch,
} from "./qualification-cohort-scrub-dispatch";

const identity = qualificationCohortScrubDispatchIdentity("cohort", "execution");
const completeOutput = {
  cohortId: identity.cohortId,
  executionId: identity.executionId,
  finalPageChecksum: "page",
  rootChecksum: "root",
  state: "SCRUBBED",
  totalPageCount: 1,
  totalPartitionCount: 1,
};

const claim = (
  overrides: Partial<
    Extract<QualificationCohortScrubDispatchClaim, { readonly _tag: "Claimed" }>
  > = {},
): Extract<QualificationCohortScrubDispatchClaim, { readonly _tag: "Claimed" }> => ({
  _tag: "Claimed",
  ...identity,
  claimToken: "claim",
  leaseExpiresAt: new Date("2099-01-01T00:05:00.000Z"),
  restartApplied: false,
  restartGeneration: 0,
  restartIntentChecksum: null,
  ...overrides,
});

type Snapshot = Awaited<ReturnType<QualificationCohortScrubDispatchInstance["status"]>>;

const fixture = (snapshot: Snapshot) => {
  const calls = new Array<string>();
  let current = snapshot;
  let createFailure = false;
  let restartFailure = false;
  let afterRestart = snapshot;
  let completionAuthority: "Conflict" | "Missing" | "Ready" = "Ready";
  let reservation: QualificationCohortScrubRestartReservation = {
    _tag: "Reserved",
    generation: 1,
    intentChecksum: "intent",
  };
  const applied: QualificationCohortScrubDispatchMutation = { _tag: "Applied" };
  const instance: QualificationCohortScrubDispatchInstance = {
    id: identity.rootInstanceId,
    restart: async () => {
      calls.push("restart");
      current = afterRestart;
      if (restartFailure) throw new Error("lost restart response");
    },
    status: async () => {
      calls.push("status");
      return current;
    },
  };
  const ports: QualificationCohortScrubDispatchPorts = {
    completionAuthority: async (_identity, checksum) => {
      calls.push(`completion:${checksum}`);
      return completionAuthority;
    },
    create: async () => {
      calls.push("create");
      if (createFailure) throw new Error("lost create response");
      return instance;
    },
    get: async () => {
      calls.push("get");
      return instance;
    },
    markRestartApplied: async (_identity, _claimToken, intentChecksum) => {
      calls.push(`restartApplied:${intentChecksum}`);
      return applied;
    },
    observe: async (_identity, _claimToken, status) => {
      calls.push(`observe:${status}`);
      return applied;
    },
    reserveRestart: async () => {
      calls.push("reserveRestart");
      return reservation;
    },
    retainConflict: async () => {
      calls.push("retainConflict");
      return applied;
    },
    settle: async (_identity, _claimToken, checksum) => {
      calls.push(`settle:${checksum}`);
      return applied;
    },
  };
  return {
    calls,
    ports,
    setAfterRestart: (value: Snapshot) => {
      afterRestart = value;
    },
    setCompletionAuthority: (value: "Conflict" | "Missing" | "Ready") => {
      completionAuthority = value;
    },
    setCreateFailure: () => {
      createFailure = true;
    },
    setReservation: (value: QualificationCohortScrubRestartReservation) => {
      reservation = value;
    },
    setRestartFailure: () => {
      restartFailure = true;
    },
  };
};

it.effect("reconciles a lost create response and retains active progress", () =>
  Effect.gen(function* () {
    const test = fixture({ status: "running" });
    test.setCreateFailure();
    yield* reconcileQualificationCohortScrubDispatch(claim(), test.ports);
    expect(test.calls).toEqual(["create", "get", "status", "observe:running"]);
  }),
);

it.effect("authenticates both completion authorities before settling", () =>
  Effect.gen(function* () {
    const test = fixture({ output: completeOutput, status: "complete" });
    yield* reconcileQualificationCohortScrubDispatch(claim(), test.ports);
    expect(test.calls).toEqual(["create", "status", "completion:root", "settle:root"]);

    const missing = fixture({ output: completeOutput, status: "complete" });
    missing.setCompletionAuthority("Missing");
    const result = yield* reconcileQualificationCohortScrubDispatch(claim(), missing.ports).pipe(
      Effect.result,
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(missing.calls).toEqual(["create", "status", "completion:root", "retainConflict"]);
  }),
);

it.effect("reconciles an unapplied restart intent without reserving a new generation", () =>
  Effect.gen(function* () {
    const active = fixture({ status: "running" });
    yield* reconcileQualificationCohortScrubDispatch(
      claim({ restartGeneration: 1, restartIntentChecksum: "existing-intent" }),
      active.ports,
    );
    expect(active.calls).toEqual(["create", "status", "restartApplied:existing-intent"]);

    const complete = fixture({ output: completeOutput, status: "complete" });
    yield* reconcileQualificationCohortScrubDispatch(
      claim({ restartGeneration: 1, restartIntentChecksum: "existing-intent" }),
      complete.ports,
    );
    expect(complete.calls).toEqual(["create", "status", "completion:root", "settle:root"]);

    const unknown = fixture({ status: "unknown" });
    const unknownResult = yield* reconcileQualificationCohortScrubDispatch(
      claim({ restartGeneration: 1, restartIntentChecksum: "existing-intent" }),
      unknown.ports,
    ).pipe(Effect.result);
    expect(Result.isFailure(unknownResult)).toBe(true);
    expect(unknown.calls).toEqual(["create", "status"]);
  }),
);

it.effect("reconciles a lost restart response and settles completion immediately", () =>
  Effect.gen(function* () {
    const active = fixture({
      error: { message: "postgres unavailable", name: "PostgresError" },
      status: "errored",
    });
    active.setAfterRestart({ status: "running" });
    active.setRestartFailure();
    yield* reconcileQualificationCohortScrubDispatch(claim(), active.ports);
    expect(active.calls).toEqual([
      "create",
      "status",
      "reserveRestart",
      "restart",
      "get",
      "status",
      "restartApplied:intent",
    ]);

    const complete = fixture({
      error: { message: "postgres unavailable", name: "PostgresError" },
      status: "errored",
    });
    complete.setAfterRestart({ output: completeOutput, status: "complete" });
    complete.setRestartFailure();
    yield* reconcileQualificationCohortScrubDispatch(claim(), complete.ports);
    expect(complete.calls).toEqual([
      "create",
      "status",
      "reserveRestart",
      "restart",
      "get",
      "status",
      "completion:root",
      "settle:root",
    ]);
  }),
);

it.effect(
  "retains structural errors, explicit pause, and restart exhaustion deterministically",
  () =>
    Effect.gen(function* () {
      const structural = fixture({
        error: { message: "authority conflict", name: "QualificationCohortScrubRootConflict" },
        status: "errored",
      });
      const structuralResult = yield* reconcileQualificationCohortScrubDispatch(
        claim(),
        structural.ports,
      ).pipe(Effect.result);
      expect(Result.isFailure(structuralResult)).toBe(true);
      expect(structural.calls).toEqual(["create", "status", "retainConflict"]);

      const paused = fixture({ status: "waitingForPause" });
      yield* reconcileQualificationCohortScrubDispatch(claim(), paused.ports);
      expect(paused.calls).toEqual(["create", "status", "observe:waitingForPause"]);

      const exhausted = fixture({
        error: { message: "host exhausted", name: "WorkflowTimeoutError" },
        status: "errored",
      });
      exhausted.setReservation({ _tag: "RestartLimitReached" });
      const exhaustedResult = yield* reconcileQualificationCohortScrubDispatch(
        claim({ restartGeneration: 3 }),
        exhausted.ports,
      ).pipe(Effect.result);
      expect(Result.isFailure(exhaustedResult)).toBe(true);
      expect(exhausted.calls).toEqual(["create", "status", "reserveRestart", "retainConflict"]);
    }),
);
