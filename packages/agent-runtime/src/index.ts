import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const Identity = Schema.String.check(Schema.isUUID());
const NonEmptyText = Schema.String.check(Schema.isNonEmpty());

export const ModelCallStateSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("notStarted") }),
  Schema.Struct({
    type: Schema.Literal("pending"),
    modelCallId: Identity,
    prompt: NonEmptyText,
  }),
  Schema.Struct({
    type: Schema.Literal("succeeded"),
    modelCallId: Identity,
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    modelCallId: Identity,
    cause: Schema.Literal("modelCallFailed"),
  }),
]);

export type ModelCallState = typeof ModelCallStateSchema.Type;

export const RecordedAgentRunStateSchema = Schema.Struct({
  agentRunId: Identity,
  executionProfileRef: NonEmptyText,
  userMessage: NonEmptyText,
  modelCall: ModelCallStateSchema,
});

export type RecordedAgentRunState = typeof RecordedAgentRunStateSchema.Type;

export const RuntimeDecisionSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("startModelCall"),
    modelBinding: Schema.Literal("oz.deterministic.echo.v1"),
    prompt: NonEmptyText,
  }),
  Schema.Struct({
    type: Schema.Literal("resumeModelCall"),
    modelCallId: Identity,
    prompt: NonEmptyText,
  }),
  Schema.Struct({ type: Schema.Literal("succeed") }),
  Schema.Struct({
    type: Schema.Literal("fail"),
    cause: Schema.Literal("modelCallFailed"),
  }),
]);

export type RuntimeDecision = typeof RuntimeDecisionSchema.Type;

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly decide: (state: RecordedAgentRunState) => Effect.Effect<RuntimeDecision>;
  }
>()("@osfo/agent-runtime/AgentRuntime") {}

const decideRecordedState = (state: RecordedAgentRunState): RuntimeDecision => {
  switch (state.modelCall.type) {
    case "notStarted":
      return {
        type: "startModelCall" as const,
        modelBinding: "oz.deterministic.echo.v1" as const,
        prompt: state.userMessage,
      };
    case "pending":
      return {
        type: "resumeModelCall" as const,
        modelCallId: state.modelCall.modelCallId,
        prompt: state.modelCall.prompt,
      };
    case "succeeded":
      return { type: "succeed" as const };
    case "failed":
      return { type: "fail" as const, cause: state.modelCall.cause };
  }
};

const decide = Effect.fn("DeterministicAgentRuntime.decide")((state: RecordedAgentRunState) =>
  Effect.succeed(decideRecordedState(state)),
);

export const makeDeterministicAgentRuntimeLayer = () => Layer.succeed(AgentRuntime)({ decide });
