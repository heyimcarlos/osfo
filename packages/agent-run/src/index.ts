import {
  AgentRuntime,
  type RecordedAgentRunState,
  type RuntimeDecision,
} from "@osfo/agent-runtime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  makeProviderFiberSupervisor,
  type ProviderFiberReservation,
} from "./provider-supervisor.js";

const Identity = Schema.String.check(Schema.isUUID());
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const PositiveEpoch = Schema.String.check(Schema.isPattern(/^[1-9]\d*$/u));
const NonEmptyText = Schema.String.check(Schema.isNonEmpty());

export const RunnableAgentRunDeliverySchema = Schema.Struct({
  version: Schema.Literal(1),
  deliveryId: Identity,
  agentRunId: Identity,
  threadId: Identity,
  executionProfileRef: NonEmptyText,
});

export type RunnableAgentRunDelivery = typeof RunnableAgentRunDeliverySchema.Type;

export class InvalidRunnableDelivery extends Data.TaggedError("InvalidRunnableDelivery")<{
  readonly cause: unknown;
}> {}

const RunnableDeliveryFromJson = Schema.fromJsonString(RunnableAgentRunDeliverySchema);

export const decodeRunnableDeliveryData = Effect.fn("RunnableDelivery.decodeData")(function* (
  data: Uint8Array,
) {
  return yield* Schema.decodeUnknownEffect(RunnableDeliveryFromJson)(
    Buffer.from(data).toString("utf8"),
  ).pipe(Effect.mapError((cause) => new InvalidRunnableDelivery({ cause })));
});

export const encodeRunnableDeliveryData = (delivery: RunnableAgentRunDelivery) =>
  Buffer.from(JSON.stringify(delivery), "utf8").toString("base64");

export const AgentRunFenceSchema = Schema.Struct({
  agentRunId: Identity,
  workerId: NonEmptyText,
  claimEpoch: PositiveEpoch,
});

export type AgentRunFence = typeof AgentRunFenceSchema.Type;

export const PreparedModelCallSchema = Schema.Struct({
  modelCallId: Identity,
  modelBinding: NonEmptyText,
  prompt: NonEmptyText,
});

export type PreparedModelCall = typeof PreparedModelCallSchema.Type;

export const ModelCallAttemptSchema = Schema.Struct({
  ...PreparedModelCallSchema.fields,
  assistantOutputId: Identity,
  modelCallAttemptId: Identity,
  attemptNumber: PositiveInteger,
  usage: Schema.Struct({ type: Schema.Literal("unknown") }),
});

export type ModelCallAttempt = typeof ModelCallAttemptSchema.Type;

export type ModelCallAttemptStart =
  | { readonly type: "started"; readonly attempt: ModelCallAttempt }
  | { readonly type: "cleanupRequired"; readonly attempt: ModelCallAttempt }
  | { readonly type: "recoveredInterruption" };

export const ModelCallObservationSchema = Schema.Struct({
  fragmentIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  text: NonEmptyText,
});

export type ModelCallObservation = typeof ModelCallObservationSchema.Type;

export const AgentRunClaimSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("busy") }),
  Schema.Struct({
    type: Schema.Literal("terminal"),
    outcome: Schema.Literals(["succeeded", "failed", "canceled"]),
  }),
  Schema.Struct({ type: Schema.Literal("claimed"), fence: AgentRunFenceSchema }),
]);

export type AgentRunClaim = typeof AgentRunClaimSchema.Type;

export const PublicationClaimSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("claimed"),
    outboxId: Identity,
    publicationEpoch: PositiveEpoch,
    relayId: NonEmptyText,
    delivery: RunnableAgentRunDeliverySchema,
  }),
]);

export type PublicationClaim = typeof PublicationClaimSchema.Type;

export const PublicationSelectionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("selected"),
    outboxIds: Schema.Array(Identity).check(Schema.isMinLength(1)),
  }),
]);

export type PublicationSelection = typeof PublicationSelectionSchema.Type;

export const PublicationConfirmationSchema = Schema.Struct({
  providerMessageId: NonEmptyText,
});

export type PublicationConfirmation = typeof PublicationConfirmationSchema.Type;

export class AgentRunRepositoryUnavailable extends Data.TaggedError(
  "AgentRunRepositoryUnavailable",
)<{ readonly cause: unknown }> {}

export class AgentRunFenceRejected extends Data.TaggedError("AgentRunFenceRejected") {}

export class AgentRunCancellationObserved extends Data.TaggedError(
  "AgentRunCancellationObserved",
) {}

export type AgentRunRepositoryError =
  | AgentRunRepositoryUnavailable
  | AgentRunFenceRejected
  | AgentRunCancellationObserved;

export const AgentRunCleanupResultSchema = Schema.Struct({
  cleanupDisposition: Schema.Union([
    Schema.Struct({ type: Schema.Literal("completed") }),
    Schema.Struct({ type: Schema.Literal("deadlineExceeded") }),
  ]),
  externalWorkMayContinue: Schema.Boolean,
});

export type AgentRunCleanupResult = typeof AgentRunCleanupResultSchema.Type;

export const AgentRunCancellationDirectiveSchema = Schema.Struct({
  cleanupDeadlineAtEpochMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  startedModelCallAttemptIds: Schema.Array(Identity),
});

export type AgentRunCancellationDirective = typeof AgentRunCancellationDirectiveSchema.Type;

type ModelCallDecision = Extract<
  RuntimeDecision,
  { readonly type: "startModelCall" | "resumeModelCall" }
>;
type TerminalDecision = Extract<RuntimeDecision, { readonly type: "succeed" | "fail" }>;

export interface AgentRunRepositoryService {
  readonly selectPublication: (request: {
    readonly publicationWindowSize: number;
  }) => Effect.Effect<PublicationSelection, AgentRunRepositoryError>;
  readonly claimPublication: (request: {
    readonly relayId: string;
    readonly leaseDurationMs: number;
  }) => Effect.Effect<PublicationClaim, AgentRunRepositoryError>;
  readonly confirmPublication: (
    claim: Extract<PublicationClaim, { readonly type: "claimed" }>,
    confirmation: PublicationConfirmation,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly claimAgentRun: (
    delivery: RunnableAgentRunDelivery,
    request: { readonly workerId: string; readonly leaseDurationMs: number },
  ) => Effect.Effect<AgentRunClaim, AgentRunRepositoryError>;
  readonly loadRecordedState: (
    fence: AgentRunFence,
  ) => Effect.Effect<RecordedAgentRunState, AgentRunRepositoryError>;
  readonly ensureModelCall: (
    fence: AgentRunFence,
    decision: ModelCallDecision,
  ) => Effect.Effect<PreparedModelCall, AgentRunRepositoryError>;
  readonly beginModelCallAttempt: (
    fence: AgentRunFence,
    modelCall: PreparedModelCall,
  ) => Effect.Effect<ModelCallAttemptStart, AgentRunRepositoryError>;
  readonly appendModelOutput: (
    fence: AgentRunFence,
    attempt: ModelCallAttempt,
    observation: ModelCallObservation,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly completeModelCall: (
    fence: AgentRunFence,
    attempt: ModelCallAttempt,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly interruptModelCall: (
    fence: AgentRunFence,
    attempt: ModelCallAttempt,
    cause: "modelCallFailed",
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly recordModelCallCleanup: (
    fence: AgentRunFence,
    attempt: ModelCallAttempt,
    cleanup: AgentRunCleanupResult,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly loadCancellation: (
    fence: AgentRunFence,
  ) => Effect.Effect<AgentRunCancellationDirective, AgentRunRepositoryError>;
  readonly renewLease: (
    fence: AgentRunFence,
    leaseDurationMs: number,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly commitCancellation: (
    fence: AgentRunFence,
    cleanup: AgentRunCleanupResult,
  ) => Effect.Effect<AgentRunCleanupResult, AgentRunRepositoryError>;
  readonly commitTerminal: (
    fence: AgentRunFence,
    decision: TerminalDecision,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
}

export class AgentRunRepository extends Context.Service<
  AgentRunRepository,
  AgentRunRepositoryService
>()("@osfo/agent-run/AgentRunRepository") {}

export class ModelCallExecutionError extends Data.TaggedError("ModelCallExecutionError")<{
  readonly cause: unknown;
}> {}

export const ModelCallCancellationDispositionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("confirmedStopped") }),
  Schema.Struct({ type: Schema.Literal("mayContinue") }),
]);

export type ModelCallCancellationDisposition = typeof ModelCallCancellationDispositionSchema.Type;

export class ModelCallExecutor extends Context.Service<
  ModelCallExecutor,
  {
    readonly execute: (
      attempt: ModelCallAttempt,
    ) => Stream.Stream<ModelCallObservation, ModelCallExecutionError>;
    readonly cancel: (
      attempt: ModelCallAttempt,
    ) => Effect.Effect<ModelCallCancellationDisposition, ModelCallExecutionError>;
  }
>()("@osfo/agent-run/ModelCallExecutor") {}

export const makeDeterministicModelCallExecutorLayer = () =>
  Layer.succeed(ModelCallExecutor)({
    execute: (attempt) =>
      Stream.make({ fragmentIndex: 0, text: "Echo: " }, { fragmentIndex: 1, text: attempt.prompt }),
    cancel: () => Effect.succeed({ type: "confirmedStopped" }),
  });

export const AgentRunWorkerDispositionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("retry") }),
  Schema.Struct({
    type: Schema.Literal("acknowledge"),
    outcome: Schema.Literals(["succeeded", "failed", "canceled", "alreadyTerminal"]),
  }),
]);

export type AgentRunWorkerDisposition = typeof AgentRunWorkerDispositionSchema.Type;

export class AgentRunWorker extends Context.Service<
  AgentRunWorker,
  {
    readonly handle: (
      delivery: RunnableAgentRunDelivery,
    ) => Effect.Effect<AgentRunWorkerDisposition>;
  }
>()("@osfo/agent-run/AgentRunWorker") {}

export const AgentRunWorkerConfigSchema = Schema.Struct({
  executionProfileRef: NonEmptyText,
  workerId: NonEmptyText,
  leaseDurationMs: PositiveInteger,
  leaseRenewalIntervalMs: PositiveInteger,
  cancellationPollIntervalMs: PositiveInteger,
  providerSupervisorAttemptLimit: Schema.optional(PositiveInteger),
  providerSupervisorDrainTimeoutMs: Schema.optional(PositiveInteger),
}).check(
  Schema.makeFilter((config) =>
    config.leaseRenewalIntervalMs * 3 <= config.leaseDurationMs
      ? undefined
      : {
          path: ["leaseRenewalIntervalMs"],
          issue: "lease renewal interval must be at most one third of the lease duration",
        },
  ),
);

export type AgentRunWorkerConfig = typeof AgentRunWorkerConfigSchema.Type;

export class InvalidAgentRunWorkerConfig extends Data.TaggedError("InvalidAgentRunWorkerConfig")<{
  readonly cause: unknown;
}> {}

const agentRunWorkerLayer = (config: AgentRunWorkerConfig) =>
  Layer.effect(
    AgentRunWorker,
    Effect.gen(function* () {
      const repository = yield* AgentRunRepository;
      const runtime = yield* AgentRuntime;
      const executor = yield* ModelCallExecutor;
      const providerSupervisor = yield* makeProviderFiberSupervisor(
        (config.providerSupervisorAttemptLimit ?? 32) * 2,
        config.providerSupervisorDrainTimeoutMs ?? 1_000,
      );

      const observeExecutorCleanup = Effect.fn("AgentRunWorker.observeExecutorCleanup")(function* (
        attempt: ModelCallAttempt,
        deadlineAtEpochMs: number,
        reservation: ProviderFiberReservation,
      ) {
        const cleanupFiber = yield* reservation.fork(executor.cancel(attempt));
        const beforeCleanup = yield* Clock.currentTimeMillis;
        const remainingMs = deadlineAtEpochMs - beforeCleanup;
        if (remainingMs <= 0) {
          return {
            cleanupDisposition: { type: "deadlineExceeded" as const },
            externalWorkMayContinue: true,
          };
        }
        const settled = yield* Fiber.await(cleanupFiber).pipe(Effect.timeoutOption(remainingMs));
        if (Option.isNone(settled)) {
          return {
            cleanupDisposition: { type: "deadlineExceeded" as const },
            externalWorkMayContinue: true,
          };
        }
        const cleanupExit = settled.value;
        const afterCleanup = yield* Clock.currentTimeMillis;
        return {
          cleanupDisposition: {
            type:
              afterCleanup >= deadlineAtEpochMs
                ? ("deadlineExceeded" as const)
                : ("completed" as const),
          },
          externalWorkMayContinue:
            Exit.isFailure(cleanupExit) ||
            (Exit.isSuccess(cleanupExit) && cleanupExit.value.type === "mayContinue"),
        };
      });

      const recordCleanup = Effect.fn("AgentRunWorker.recordCleanup")(function* (
        fence: AgentRunFence,
        attempt: ModelCallAttempt,
        cleanup: AgentRunCleanupResult,
        deadlineAtEpochMs: number,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const remainingMs = deadlineAtEpochMs - now;
        if (remainingMs <= 0) {
          return yield* new AgentRunRepositoryUnavailable({
            cause: "ModelCallAttempt cleanup persistence deadline exceeded",
          });
        }
        const recorded = yield* repository.recordModelCallCleanup(fence, attempt, cleanup).pipe(
          Effect.retry({
            schedule: Schedule.spaced(10),
            while: Predicate.isTagged("AgentRunRepositoryUnavailable"),
          }),
          Effect.timeoutOption(remainingMs),
        );
        if (Option.isNone(recorded)) {
          return yield* new AgentRunRepositoryUnavailable({
            cause: "ModelCallAttempt cleanup persistence deadline exceeded",
          });
        }
      });

      const cleanupMaintenanceFailure = Effect.fn("AgentRunWorker.cleanupMaintenanceFailure")(
        function* (
          fence: AgentRunFence,
          attempt: ModelCallAttempt,
          execution: Fiber.Fiber<"completed" | "interrupted", AgentRunRepositoryError>,
          reservation: ProviderFiberReservation,
        ) {
          yield* Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const cleanup = yield* observeExecutorCleanup(
              attempt,
              now + config.leaseRenewalIntervalMs,
              reservation,
            );
            yield* recordCleanup(fence, attempt, cleanup, now + config.leaseDurationMs);
          }).pipe(
            Effect.ensuring(reservation.releaseUnused),
            Effect.ensuring(
              Effect.sync(() => {
                execution.interruptUnsafe();
              }),
            ),
          );
        },
      );

      const commitCancellation = Effect.fn("AgentRunWorker.commitCancellation")(function* (
        fence: AgentRunFence,
        activeAttempt: ModelCallAttempt | undefined,
        activeExecution:
          | Fiber.Fiber<"completed" | "interrupted", AgentRunRepositoryError>
          | undefined,
        activeReservation: ProviderFiberReservation | undefined,
      ) {
        const cancellation = Effect.gen(function* () {
          const directive = yield* repository.loadCancellation(fence).pipe(
            Effect.catchTags({
              AgentRunFenceRejected: (error) =>
                activeAttempt !== undefined &&
                activeExecution !== undefined &&
                activeReservation !== undefined
                  ? cleanupMaintenanceFailure(
                      fence,
                      activeAttempt,
                      activeExecution,
                      activeReservation,
                    ).pipe(Effect.andThen(Effect.fail(error)))
                  : Effect.fail(error),
              AgentRunRepositoryUnavailable: (error) =>
                activeAttempt !== undefined &&
                activeExecution !== undefined &&
                activeReservation !== undefined
                  ? cleanupMaintenanceFailure(
                      fence,
                      activeAttempt,
                      activeExecution,
                      activeReservation,
                    ).pipe(Effect.andThen(Effect.fail(error)))
                  : Effect.fail(error),
            }),
          );
          const otherUnconfirmedAttempt = directive.startedModelCallAttemptIds.some(
            (attemptId) => attemptId !== activeAttempt?.modelCallAttemptId,
          );
          let cleanup: AgentRunCleanupResult = {
            cleanupDisposition: { type: "completed" },
            externalWorkMayContinue: otherUnconfirmedAttempt,
          };

          if (activeAttempt !== undefined && activeReservation !== undefined) {
            const activeCleanup = yield* observeExecutorCleanup(
              activeAttempt,
              directive.cleanupDeadlineAtEpochMs,
              activeReservation,
            );
            const persistenceStartedAt = yield* Clock.currentTimeMillis;
            yield* recordCleanup(
              fence,
              activeAttempt,
              activeCleanup,
              persistenceStartedAt + config.leaseDurationMs,
            );
            cleanup = {
              cleanupDisposition: activeCleanup.cleanupDisposition,
              externalWorkMayContinue:
                otherUnconfirmedAttempt || activeCleanup.externalWorkMayContinue,
            };
          }

          return yield* repository.commitCancellation(fence, cleanup);
        });
        return yield* cancellation.pipe(
          Effect.ensuring(activeReservation?.releaseUnused ?? Effect.void),
          Effect.ensuring(
            Effect.sync(() => {
              activeExecution?.interruptUnsafe();
            }),
          ),
        );
      });

      const driveClaim = Effect.fn("AgentRunWorker.driveClaim")(function* (fence: AgentRunFence) {
        let activeAttempt: ModelCallAttempt | undefined;
        let activeExecution:
          | Fiber.Fiber<"completed" | "interrupted", AgentRunRepositoryError>
          | undefined;
        let activeReservation: ProviderFiberReservation | undefined;
        const body = Effect.gen(function* () {
          while (true) {
            const state = yield* repository.loadRecordedState(fence);
            const decision = yield* runtime.decide(state);

            if (decision.type === "succeed" || decision.type === "fail") {
              yield* repository.commitTerminal(fence, decision);
              return {
                type: "acknowledge" as const,
                outcome: decision.type === "succeed" ? ("succeeded" as const) : ("failed" as const),
              };
            }

            const modelCall = yield* repository.ensureModelCall(fence, decision);
            const attemptStart = yield* repository.beginModelCallAttempt(fence, modelCall);
            if (attemptStart.type === "cleanupRequired") {
              const reservation = yield* providerSupervisor.reserve(1);
              yield* Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const cleanup = yield* observeExecutorCleanup(
                  attemptStart.attempt,
                  now + config.leaseRenewalIntervalMs,
                  reservation,
                );
                yield* recordCleanup(
                  fence,
                  attemptStart.attempt,
                  cleanup,
                  now + config.leaseDurationMs,
                );
              }).pipe(Effect.ensuring(reservation.releaseUnused));
              continue;
            }
            if (attemptStart.type === "recoveredInterruption") continue;
            const attempt = attemptStart.attempt;
            const reservation = yield* providerSupervisor.reserve(2);
            activeAttempt = attempt;
            activeReservation = reservation;
            const execution = Stream.runForEach(executor.execute(attempt), (observation) =>
              repository.appendModelOutput(fence, attempt, observation),
            ).pipe(
              Effect.as("completed" as const),
              Effect.catchTag("ModelCallExecutionError", () =>
                Effect.succeed("interrupted" as const),
              ),
            );
            const cancellation = Effect.forever(
              Effect.sleep(config.cancellationPollIntervalMs).pipe(
                Effect.andThen(repository.loadRecordedState(fence)),
                Effect.asVoid,
              ),
            );
            const renewal = Effect.forever(
              repository
                .renewLease(fence, config.leaseDurationMs)
                .pipe(Effect.andThen(Effect.sleep(config.leaseRenewalIntervalMs))),
            );
            const maintenance = Effect.all([cancellation, renewal], {
              concurrency: 2,
              discard: true,
            });
            const executionFiber = yield* reservation.fork(execution);
            activeExecution = executionFiber;
            yield* Effect.raceFirst(Fiber.await(executionFiber).pipe(Effect.asVoid), maintenance);
            const executionResult = yield* Fiber.join(executionFiber);
            if (executionResult === "interrupted") {
              yield* repository.interruptModelCall(fence, attempt, "modelCallFailed");
              yield* reservation.releaseUnused;
              activeAttempt = undefined;
              activeExecution = undefined;
              activeReservation = undefined;
              continue;
            }
            yield* repository.completeModelCall(fence, attempt);
            yield* reservation.releaseUnused;
            activeAttempt = undefined;
            activeExecution = undefined;
            activeReservation = undefined;
          }
        });
        const canceled = body.pipe(
          Effect.catchTag("AgentRunCancellationObserved", () => {
            const reservation = activeReservation;
            activeReservation = undefined;
            return commitCancellation(fence, activeAttempt, activeExecution, reservation).pipe(
              Effect.as({
                type: "acknowledge" as const,
                outcome: "canceled" as const,
              }),
            );
          }),
        );
        return yield* canceled.pipe(
          Effect.catchTags({
            AgentRunFenceRejected: (error) => {
              const reservation = activeReservation;
              activeReservation = undefined;
              return activeAttempt !== undefined && activeExecution !== undefined && reservation
                ? cleanupMaintenanceFailure(
                    fence,
                    activeAttempt,
                    activeExecution,
                    reservation,
                  ).pipe(Effect.andThen(Effect.fail(error)))
                : Effect.fail(error);
            },
            AgentRunRepositoryUnavailable: (error) => {
              const reservation = activeReservation;
              activeReservation = undefined;
              return activeAttempt !== undefined && activeExecution !== undefined && reservation
                ? cleanupMaintenanceFailure(
                    fence,
                    activeAttempt,
                    activeExecution,
                    reservation,
                  ).pipe(Effect.andThen(Effect.fail(error)))
                : Effect.fail(error);
            },
          }),
          Effect.ensuring(
            Effect.suspend(() => {
              const reservation = activeReservation;
              activeReservation = undefined;
              activeExecution?.interruptUnsafe();
              return reservation?.releaseUnused ?? Effect.void;
            }),
          ),
        );
      });

      const handle = Effect.fn("AgentRunWorker.handle")(function* (
        delivery: RunnableAgentRunDelivery,
      ) {
        if (delivery.executionProfileRef !== config.executionProfileRef) {
          return { type: "retry" as const };
        }
        const handled = Effect.gen(function* () {
          const claim = yield* repository.claimAgentRun(delivery, config);
          switch (claim.type) {
            case "busy":
              return { type: "retry" as const };
            case "terminal":
              return {
                type: "acknowledge" as const,
                outcome: "alreadyTerminal" as const,
              };
            case "claimed":
              return yield* driveClaim(claim.fence);
          }
        });
        return yield* handled.pipe(
          Effect.catchTags({
            AgentRunCancellationObserved: () => Effect.succeed({ type: "retry" as const }),
            AgentRunFenceRejected: () => Effect.succeed({ type: "retry" as const }),
            AgentRunRepositoryUnavailable: () => Effect.succeed({ type: "retry" as const }),
            UnsupportedExecutionProfile: () => Effect.succeed({ type: "retry" as const }),
          }),
        );
      });

      return AgentRunWorker.of({ handle });
    }),
  );

export const makeAgentRunWorkerLayer = (config: AgentRunWorkerConfig) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(AgentRunWorkerConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidAgentRunWorkerConfig({ cause })),
      Effect.map(agentRunWorkerLayer),
    ),
  );

export class RunnableDeliveryPublisherUnavailable extends Data.TaggedError(
  "RunnableDeliveryPublisherUnavailable",
)<{ readonly cause: unknown }> {}

export class RunnableDeliveryPublisher extends Context.Service<
  RunnableDeliveryPublisher,
  {
    readonly publish: (
      delivery: RunnableAgentRunDelivery,
    ) => Effect.Effect<PublicationConfirmation, RunnableDeliveryPublisherUnavailable>;
  }
>()("@osfo/agent-run/RunnableDeliveryPublisher") {}

export type OutboxRelayWakeEvent =
  | { readonly type: "connected"; readonly reconnect: boolean }
  | { readonly type: "notification" };

export class OutboxRelayWake extends Context.Service<
  OutboxRelayWake,
  {
    readonly events: Stream.Stream<OutboxRelayWakeEvent, AgentRunRepositoryUnavailable>;
  }
>()("@osfo/agent-run/OutboxRelayWake") {}

export const OutboxRelaySelectionResultSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({
    type: Schema.Literal("selected"),
    outboxIds: Schema.Array(Identity).check(Schema.isMinLength(1)),
  }),
]);

export type OutboxRelaySelectionResult = typeof OutboxRelaySelectionResultSchema.Type;

export const OutboxRelayPublicationResultSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("published"), delivery: RunnableAgentRunDeliverySchema }),
]);

export type OutboxRelayPublicationResult = typeof OutboxRelayPublicationResultSchema.Type;

export class OutboxRelay extends Context.Service<
  OutboxRelay,
  {
    readonly selectOnce: () => Effect.Effect<OutboxRelaySelectionResult, AgentRunRepositoryError>;
    readonly publishOnce: () => Effect.Effect<
      OutboxRelayPublicationResult,
      AgentRunRepositoryError | RunnableDeliveryPublisherUnavailable
    >;
    readonly wakeEvents: Stream.Stream<OutboxRelayWakeEvent, AgentRunRepositoryUnavailable>;
  }
>()("@osfo/agent-run/OutboxRelay") {}

export const OutboxRelayConfigSchema = Schema.Struct({
  relayId: NonEmptyText,
  leaseDurationMs: PositiveInteger,
  publicationWindowSize: PositiveInteger,
});

export type OutboxRelayConfig = typeof OutboxRelayConfigSchema.Type;

export const makeOutboxRelayLayer = (config: OutboxRelayConfig) =>
  Layer.effect(
    OutboxRelay,
    Effect.gen(function* () {
      const repository = yield* AgentRunRepository;
      const publisher = yield* RunnableDeliveryPublisher;
      const wake = yield* OutboxRelayWake;

      const selectOnce = Effect.fn("OutboxRelay.selectOnce")(function* () {
        const selection = yield* repository.selectPublication(config);
        return selection.type === "none"
          ? ({ type: "idle" } as const)
          : ({ type: "selected", outboxIds: selection.outboxIds } as const);
      });

      const publishOnce = Effect.fn("OutboxRelay.publishOnce")(function* () {
        const claim = yield* repository.claimPublication(config);
        if (claim.type === "none") return { type: "idle" as const };
        const confirmation = yield* publisher.publish(claim.delivery);
        yield* repository.confirmPublication(claim, confirmation);
        return { type: "published" as const, delivery: claim.delivery };
      });

      return OutboxRelay.of({ selectOnce, publishOnce, wakeEvents: wake.events });
    }),
  );
