/* oxlint-disable eslint/no-underscore-dangle -- Effect/domain outcomes use the canonical _tag discriminator. */
import { Data, Effect, Result } from "effect";

import type {
  QualificationCohortScrubDispatchClaim,
  QualificationCohortScrubDispatchMutation,
  QualificationCohortScrubRestartReservation,
} from "../integrations/postgres/qualification-cohort-scrub-dispatch";
import {
  qualificationCohortScrubWorkflowObservation,
  type QualificationCohortScrubDispatchIdentity,
} from "../qualification/cohort-scrub-dispatch";
import { qualificationChecksum } from "../qualification/qualification-checksum";

export class QualificationCohortScrubDispatchConflict extends Data.TaggedError(
  "QualificationCohortScrubDispatchConflict",
)<{ readonly message: string }> {}

export class QualificationCohortScrubDispatchRetryable extends Data.TaggedError(
  "QualificationCohortScrubDispatchRetryable",
)<{ readonly message: string }> {}

export interface QualificationCohortScrubDispatchInstance {
  readonly id: string;
  readonly restart: () => Promise<void>;
  readonly status: () => Promise<{
    readonly error?: { readonly message: string; readonly name: string } | undefined;
    readonly output?: unknown;
    readonly status:
      | "complete"
      | "errored"
      | "paused"
      | "queued"
      | "running"
      | "terminated"
      | "unknown"
      | "waiting"
      | "waitingForPause";
  }>;
}

export interface QualificationCohortScrubDispatchPorts {
  readonly completionAuthority: (
    identity: QualificationCohortScrubDispatchIdentity,
    rootChecksum: string,
  ) => Promise<"Conflict" | "Missing" | "Ready">;
  readonly create: (
    identity: QualificationCohortScrubDispatchIdentity,
  ) => Promise<QualificationCohortScrubDispatchInstance>;
  readonly get: (instanceId: string) => Promise<QualificationCohortScrubDispatchInstance>;
  readonly markRestartApplied: (
    identity: QualificationCohortScrubDispatchIdentity,
    claimToken: string,
    intentChecksum: string,
  ) => Promise<QualificationCohortScrubDispatchMutation>;
  readonly observe: (
    identity: QualificationCohortScrubDispatchIdentity,
    claimToken: string,
    status: string,
  ) => Promise<QualificationCohortScrubDispatchMutation>;
  readonly reserveRestart: (
    identity: QualificationCohortScrubDispatchIdentity,
    claimToken: string,
    statusChecksum: string,
  ) => Promise<QualificationCohortScrubRestartReservation>;
  readonly retainConflict: (
    identity: QualificationCohortScrubDispatchIdentity,
    claimToken: string,
    failureChecksum: string,
  ) => Promise<QualificationCohortScrubDispatchMutation>;
  readonly settle: (
    identity: QualificationCohortScrubDispatchIdentity,
    claimToken: string,
    rootChecksum: string,
  ) => Promise<QualificationCohortScrubDispatchMutation>;
}

export const reconcileQualificationCohortScrubDispatch: (
  claim: Extract<QualificationCohortScrubDispatchClaim, { readonly _tag: "Claimed" }>,
  ports: QualificationCohortScrubDispatchPorts,
) => Effect.Effect<
  void,
  QualificationCohortScrubDispatchConflict | QualificationCohortScrubDispatchRetryable
> = Effect.fn("QualificationCohortScrubDispatch.reconcile")(function* (
  claim: Extract<QualificationCohortScrubDispatchClaim, { readonly _tag: "Claimed" }>,
  ports: QualificationCohortScrubDispatchPorts,
) {
  const identity = dispatchIdentity(claim);
  const created = yield* Effect.tryPromise({
    try: () => ports.create(identity),
    catch: () => retryable("root Workflow create response is unavailable"),
  }).pipe(Effect.result);
  const instance = Result.isSuccess(created)
    ? created.success
    : yield* Effect.tryPromise({
        try: () => ports.get(identity.rootInstanceId),
        catch: () => retryable("root Workflow create/get is unavailable"),
      });
  if (instance.id !== identity.rootInstanceId) {
    return yield* retainConflict(claim, ports, "root Workflow instance identity conflicts");
  }
  const snapshot = yield* Effect.tryPromise({
    try: instance.status,
    catch: () => retryable("root Workflow status is unavailable"),
  });
  const observation = qualificationCohortScrubWorkflowObservation(identity, snapshot);
  if (observation._tag === "Complete") {
    return yield* settleComplete(claim, ports, observation.rootChecksum);
  }
  if (observation._tag === "Conflict") {
    return yield* retainConflict(claim, ports, "root Workflow authority conflicts");
  }
  if (claim.restartIntentChecksum !== null && !claim.restartApplied) {
    if (observation._tag === "Active" || observation._tag === "Paused") {
      return yield* exactMutation(
        ports.markRestartApplied(identity, claim.claimToken, claim.restartIntentChecksum),
        "root restart reconciliation",
      );
    }
    if (observation._tag === "Transient") {
      return yield* retryable("root restart remains unknown");
    }
    return yield* retainConflict(claim, ports, "root restart response remains terminal");
  }
  if (observation._tag === "Restartable") {
    const reservation = yield* Effect.tryPromise({
      try: () => ports.reserveRestart(identity, claim.claimToken, observation.checksum),
      catch: () => retryable("root restart reservation is unavailable"),
    });
    if (reservation._tag === "LeaseExpired") {
      return yield* retryable("dispatch lease expired");
    }
    if (reservation._tag === "RestartLimitReached") {
      return yield* retainConflict(claim, ports, "root restart limit reached");
    }
    if (reservation._tag === "Conflict") {
      return yield* conflict("root restart reservation conflicts");
    }
    const restarted = yield* Effect.tryPromise({
      try: instance.restart,
      catch: () => retryable("root restart response is unavailable"),
    }).pipe(Effect.result);
    if (Result.isSuccess(restarted)) {
      return yield* exactMutation(
        ports.markRestartApplied(identity, claim.claimToken, reservation.intentChecksum),
        "root restart application",
      );
    }
    const reconciled = yield* Effect.tryPromise({
      try: () => ports.get(identity.rootInstanceId).then((current) => current.status()),
      catch: () => retryable("root restart reconciliation is unavailable"),
    });
    const outcome = qualificationCohortScrubWorkflowObservation(identity, reconciled);
    if (outcome._tag === "Active" || outcome._tag === "Paused") {
      return yield* exactMutation(
        ports.markRestartApplied(identity, claim.claimToken, reservation.intentChecksum),
        "root restart reconciliation",
      );
    }
    if (outcome._tag === "Complete") {
      return yield* settleComplete(claim, ports, outcome.rootChecksum);
    }
    if (outcome._tag === "Transient") {
      return yield* retryable("root restart remains unknown");
    }
    return yield* retainConflict(claim, ports, "root restart response remains terminal");
  }
  // An operator pause is retained as operational state. Hourly recovery observes it but never
  // resumes or restarts it without a separate, explicit administrative policy.
  return yield* exactMutation(
    ports.observe(identity, claim.claimToken, observation.status),
    "root dispatch observation",
  );
});

const dispatchIdentity = (
  claim: Extract<QualificationCohortScrubDispatchClaim, { readonly _tag: "Claimed" }>,
): QualificationCohortScrubDispatchIdentity => ({
  cohortId: claim.cohortId,
  dispatchId: claim.dispatchId,
  executionId: claim.executionId,
  protocolVersion: claim.protocolVersion,
  rootInstanceId: claim.rootInstanceId,
});

const exactMutation = (
  mutation: Promise<QualificationCohortScrubDispatchMutation>,
  operation: string,
) =>
  Effect.tryPromise({
    try: () => mutation,
    catch: () => retryable(`${operation} is unavailable`),
  }).pipe(
    Effect.flatMap(
      (
        outcome,
      ): Effect.Effect<
        void,
        QualificationCohortScrubDispatchConflict | QualificationCohortScrubDispatchRetryable
      > => {
        if (outcome._tag === "Applied") return Effect.void;
        return outcome._tag === "LeaseExpired"
          ? retryable(`${operation} lease expired`)
          : conflict(`${operation} conflicts`);
      },
    ),
  );

const settleComplete = (
  claim: Extract<QualificationCohortScrubDispatchClaim, { readonly _tag: "Claimed" }>,
  ports: QualificationCohortScrubDispatchPorts,
  rootChecksum: string,
) =>
  Effect.gen(function* () {
    const identity = dispatchIdentity(claim);
    const authority = yield* Effect.tryPromise({
      try: () => ports.completionAuthority(identity, rootChecksum),
      catch: () => retryable("root completion authority is unavailable"),
    });
    if (authority !== "Ready") {
      return yield* retainConflict(
        claim,
        ports,
        authority === "Missing"
          ? "root completion authority is missing"
          : "root completion authority conflicts",
      );
    }
    return yield* exactMutation(
      ports.settle(identity, claim.claimToken, rootChecksum),
      "root dispatch settlement",
    );
  });

const retainConflict = (
  claim: Extract<QualificationCohortScrubDispatchClaim, { readonly _tag: "Claimed" }>,
  ports: QualificationCohortScrubDispatchPorts,
  message: string,
) => {
  const identity = dispatchIdentity(claim);
  return exactMutation(
    ports.retainConflict(
      identity,
      claim.claimToken,
      qualificationChecksum({ dispatchId: identity.dispatchId, message }),
    ),
    "root dispatch conflict retention",
  ).pipe(Effect.andThen(Effect.fail(conflict(message))));
};

const conflict = (message: string) => new QualificationCohortScrubDispatchConflict({ message });
const retryable = (message: string) => new QualificationCohortScrubDispatchRetryable({ message });
