import {
  AgentRuntime,
  type RecordedAgentRunState,
  type RuntimeDecision,
} from "@osfo/agent-runtime";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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

export type AgentRunRepositoryError = AgentRunRepositoryUnavailable | AgentRunFenceRejected;

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
  ) => Effect.Effect<ModelCallAttempt, AgentRunRepositoryError>;
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

export class ModelCallExecutor extends Context.Service<
  ModelCallExecutor,
  {
    readonly execute: (
      attempt: ModelCallAttempt,
    ) => Stream.Stream<ModelCallObservation, ModelCallExecutionError>;
  }
>()("@osfo/agent-run/ModelCallExecutor") {}

export const makeDeterministicModelCallExecutorLayer = () =>
  Layer.succeed(ModelCallExecutor)({
    execute: (attempt) =>
      Stream.make({ fragmentIndex: 0, text: "Echo: " }, { fragmentIndex: 1, text: attempt.prompt }),
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
});

export type AgentRunWorkerConfig = typeof AgentRunWorkerConfigSchema.Type;

export const makeAgentRunWorkerLayer = (config: AgentRunWorkerConfig) =>
  Layer.effect(
    AgentRunWorker,
    Effect.gen(function* () {
      const repository = yield* AgentRunRepository;
      const runtime = yield* AgentRuntime;
      const executor = yield* ModelCallExecutor;

      const driveClaim = Effect.fn("AgentRunWorker.driveClaim")(function* (fence: AgentRunFence) {
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
          const attempt = yield* repository.beginModelCallAttempt(fence, modelCall);
          const execution = yield* Stream.runForEach(executor.execute(attempt), (observation) =>
            repository.appendModelOutput(fence, attempt, observation),
          ).pipe(
            Effect.as("completed" as const),
            Effect.catchTag("ModelCallExecutionError", () =>
              Effect.succeed("interrupted" as const),
            ),
          );
          if (execution === "interrupted") {
            yield* repository.interruptModelCall(fence, attempt, "modelCallFailed");
            continue;
          }
          yield* repository.completeModelCall(fence, attempt);
        }
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
            AgentRunFenceRejected: () => Effect.succeed({ type: "retry" as const }),
            AgentRunRepositoryUnavailable: () => Effect.succeed({ type: "retry" as const }),
            UnsupportedExecutionProfile: () => Effect.succeed({ type: "retry" as const }),
          }),
        );
      });

      return AgentRunWorker.of({ handle });
    }),
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
