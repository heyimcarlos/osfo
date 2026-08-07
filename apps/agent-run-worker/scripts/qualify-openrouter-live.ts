import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { ModelCallExecutor, type ModelCallAttempt } from "@osfo/agent-run";
import { Config, Data, Effect, Layer, Redacted, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import { liveOpenRouterExecutionProfile } from "../src/execution-profile.js";
import { makeOpenRouterChatCompletionsModelCallExecutorLayer } from "../src/openrouter-chat-completions-model-call-executor.js";
import {
  evaluateOpenRouterLiveQualification,
  renderOpenRouterLiveQualificationPass,
} from "../src/openrouter-live-qualification.js";

class OpenRouterLiveQualificationFailed extends Data.TaggedError(
  "OpenRouterLiveQualificationFailed",
)<{ readonly check: string }> {}

const attempt = {
  assistantOutputId: "c6441b09-716b-46c7-8421-47b012c0f3d7",
  attemptNumber: 1,
  modelBinding: liveOpenRouterExecutionProfile.modelBinding,
  modelCallAttemptId: "44a00f26-e5d4-47c7-99fe-f6925c7a48c8",
  modelCallId: "8396cc12-3422-48d1-969d-814ac39c032d",
  prompt: "Think privately, then answer with only the word qualified.",
  usage: { type: "unknown" },
} as const satisfies ModelCallAttempt;

const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("OPENROUTER_API_KEY");
  const baseHttp = yield* HttpClient.HttpClient;
  let requestCount = 0;
  const countedHttp = HttpClient.make((request) =>
    Effect.sync(() => {
      requestCount += 1;
    }).pipe(Effect.andThen(baseHttp.execute(request))),
  );
  const executorLayer = makeOpenRouterChatCompletionsModelCallExecutorLayer({
    apiKey: Redacted.value(apiKey),
    profile: liveOpenRouterExecutionProfile,
  }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, countedHttp)));

  const [observations, outcome] = yield* ModelCallExecutor.use((executor) =>
    Effect.gen(function* () {
      const output = yield* Stream.runCollect(Stream.unwrap(executor.execute(attempt)));
      return [Array.from(output), yield* executor.outcome(attempt)] as const;
    }),
  ).pipe(Effect.provide(executorLayer));

  const evaluation = evaluateOpenRouterLiveQualification({
    observations,
    outcome,
    requestCount,
  });
  if (evaluation.type === "fail") {
    return yield* new OpenRouterLiveQualificationFailed({ check: evaluation.check });
  }
  yield* Effect.sync(() => console.log(renderOpenRouterLiveQualificationPass(evaluation.evidence)));
}).pipe(Effect.provide(NodeHttpClient.layerUndici));

NodeRuntime.runMain(program);
