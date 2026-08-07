import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  AgentRuntime,
  makeDeterministicAgentRuntimeLayer,
  type RecordedAgentRunState,
} from "../src/index.js";

const baseState = {
  agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
  executionProfileRef: "oz.deterministic.v1",
  userMessage: "Hello, Oz",
} as const;

const runtimeConfig = {
  executionProfileRef: "oz.deterministic.v1",
  modelBinding: "oz.deterministic.echo.v1",
} as const;

const decide = (state: RecordedAgentRunState) =>
  AgentRuntime.use((runtime) => runtime.decide(state)).pipe(
    Effect.provide(makeDeterministicAgentRuntimeLayer(runtimeConfig)),
  );

describe("deterministic Agent Runtime", () => {
  it.effect("proposes one ModelCall without acquiring authority", () =>
    Effect.gen(function* () {
      const decision = yield* decide({ ...baseState, modelCall: { type: "notStarted" } });

      expect(decision).toEqual({
        type: "startModelCall",
        modelBinding: "oz.deterministic.echo.v1",
        prompt: "Hello, Oz",
      });
    }),
  );

  it.effect("retries the same durable ModelCall after worker replacement", () =>
    Effect.gen(function* () {
      const decision = yield* decide({
        ...baseState,
        modelCall: {
          type: "pending",
          modelCallId: "1d27079d-635d-47e2-ab68-588fff581e3e",
          prompt: "Hello, Oz",
        },
      });

      expect(decision).toEqual({
        type: "resumeModelCall",
        modelCallId: "1d27079d-635d-47e2-ab68-588fff581e3e",
        prompt: "Hello, Oz",
      });
    }),
  );

  it.effect("proposes the terminal outcome from the normalized ModelCall result", () =>
    Effect.gen(function* () {
      const succeeded = yield* decide({
        ...baseState,
        modelCall: {
          type: "succeeded",
          modelCallId: "1d27079d-635d-47e2-ab68-588fff581e3e",
        },
      });
      const failed = yield* decide({
        ...baseState,
        modelCall: {
          type: "failed",
          modelCallId: "1d27079d-635d-47e2-ab68-588fff581e3e",
          cause: "modelCallFailed",
        },
      });

      expect(succeeded).toEqual({ type: "succeed" });
      expect(failed).toEqual({ type: "fail", cause: "modelCallFailed" });
    }),
  );
});
