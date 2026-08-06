import {
  AgentRuntime,
  type RecordedAgentRunState,
  type RuntimeDecision,
} from "@osfo/agent-runtime";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
});

export type RunnableAgentRunDelivery = typeof RunnableAgentRunDeliverySchema.Type;

export const PubSubPushEnvelopeSchema = Schema.Struct({
  message: Schema.Struct({
    data: Schema.NonEmptyString,
    messageId: Schema.NonEmptyString,
  }),
  subscription: Schema.NonEmptyString,
});

export type PubSubPushEnvelope = typeof PubSubPushEnvelopeSchema.Type;

export class InvalidRunnableDelivery extends Data.TaggedError("InvalidRunnableDelivery")<{
  readonly cause: unknown;
}> {}

const RunnableDeliveryFromJson = Schema.fromJsonString(RunnableAgentRunDeliverySchema);

export const decodePubSubPushDelivery = Effect.fn("PubSubPush.decodeDelivery")(function* (
  input: unknown,
) {
  const envelope = yield* Schema.decodeUnknownEffect(PubSubPushEnvelopeSchema)(input).pipe(
    Effect.mapError((cause) => new InvalidRunnableDelivery({ cause })),
  );
  const json = Buffer.from(envelope.message.data, "base64").toString("utf8");
  return yield* Schema.decodeUnknownEffect(RunnableDeliveryFromJson)(json).pipe(
    Effect.mapError((cause) => new InvalidRunnableDelivery({ cause })),
  );
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
  assistantOutputId: Identity,
  modelBinding: NonEmptyText,
  prompt: NonEmptyText,
});

export type PreparedModelCall = typeof PreparedModelCallSchema.Type;

export const ModelCallAttemptSchema = Schema.Struct({
  ...PreparedModelCallSchema.fields,
  modelCallAttemptId: Identity,
  attemptNumber: PositiveInteger,
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
  readonly claimPublication: (request: {
    readonly relayId: string;
    readonly leaseDurationMs: number;
  }) => Effect.Effect<PublicationClaim, AgentRunRepositoryError>;
  readonly confirmPublication: (
    claim: Extract<PublicationClaim, { readonly type: "claimed" }>,
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
          const execution = yield* Stream.runCollect(executor.execute(attempt)).pipe(Effect.exit);
          if (Exit.isFailure(execution)) {
            yield* repository.interruptModelCall(fence, attempt, "modelCallFailed");
            continue;
          }

          yield* Effect.forEach(Array.from(execution.value), (observation) =>
            repository.appendModelOutput(fence, attempt, observation),
          );
          yield* repository.completeModelCall(fence, attempt);
        }
      });

      const handle = Effect.fn("AgentRunWorker.handle")(function* (
        delivery: RunnableAgentRunDelivery,
      ) {
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
    ) => Effect.Effect<void, RunnableDeliveryPublisherUnavailable>;
  }
>()("@osfo/agent-run/RunnableDeliveryPublisher") {}

export const OutboxRelayResultSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("published"), delivery: RunnableAgentRunDeliverySchema }),
]);

export type OutboxRelayResult = typeof OutboxRelayResultSchema.Type;

export class OutboxRelay extends Context.Service<
  OutboxRelay,
  {
    readonly relayOnce: () => Effect.Effect<
      OutboxRelayResult,
      AgentRunRepositoryError | RunnableDeliveryPublisherUnavailable
    >;
  }
>()("@osfo/agent-run/OutboxRelay") {}

export const OutboxRelayConfigSchema = Schema.Struct({
  relayId: NonEmptyText,
  leaseDurationMs: PositiveInteger,
});

export type OutboxRelayConfig = typeof OutboxRelayConfigSchema.Type;

export const makeOutboxRelayLayer = (config: OutboxRelayConfig) =>
  Layer.effect(
    OutboxRelay,
    Effect.gen(function* () {
      const repository = yield* AgentRunRepository;
      const publisher = yield* RunnableDeliveryPublisher;

      const relayOnce = Effect.fn("OutboxRelay.relayOnce")(function* () {
        const claim = yield* repository.claimPublication(config);
        if (claim.type === "none") return { type: "idle" as const };
        yield* publisher.publish(claim.delivery);
        yield* repository.confirmPublication(claim);
        return { type: "published" as const, delivery: claim.delivery };
      });

      return OutboxRelay.of({ relayOnce });
    }),
  );
