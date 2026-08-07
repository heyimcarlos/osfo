import { describe, expect, it } from "@effect/vitest";
import {
  deterministicExecutionProfile,
  liveOpenAIExecutionProfile,
  resolveExecutionProfile,
} from "../src/execution-profile.js";

describe("Oz execution profiles", () => {
  it("pins the live Responses binding and one logical attempt", () => {
    expect(liveOpenAIExecutionProfile).toEqual({
      type: "openaiResponses",
      ref: "oz.openai.gpt-4.1-mini-2025-04-14.responses.v1",
      modelBinding: "openai.responses.gpt-4.1-mini-2025-04-14.v1",
      model: "gpt-4.1-mini-2025-04-14",
      requiredSemantics: {
        output: "text",
        protocol: "responsesSseV1",
        terminalEvent: "response.completed",
      },
      permittedAdaptations: {
        coalesceUpToDeltas: 8,
      },
      deadlines: {
        responseHeadersMs: 10_000,
        responseStreamMs: 120_000,
      },
      retry: {
        automaticProviderRetries: 0,
        modelCallAttempts: 1,
      },
      request: {
        maxOutputTokens: 1_024,
        store: false,
        stream: true,
      },
    });
    expect(Object.isFrozen(liveOpenAIExecutionProfile)).toBe(true);
    expect(Object.isFrozen(liveOpenAIExecutionProfile.retry)).toBe(true);
  });

  it("keeps the deterministic profile as a distinct binding", () => {
    expect(deterministicExecutionProfile.type).toBe("deterministic");
    expect(deterministicExecutionProfile.ref).toBe("oz.deterministic.v1");
    expect(deterministicExecutionProfile.modelBinding).toBe("oz.deterministic.echo.v1");
    expect(resolveExecutionProfile(deterministicExecutionProfile.ref)).toBe(
      deterministicExecutionProfile,
    );
    expect(resolveExecutionProfile(liveOpenAIExecutionProfile.ref)).toBe(
      liveOpenAIExecutionProfile,
    );
  });
});
