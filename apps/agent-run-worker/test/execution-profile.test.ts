import { describe, expect, it } from "@effect/vitest";
import {
  deterministicExecutionProfile,
  liveOpenRouterExecutionProfile,
  resolveExecutionProfile,
} from "../src/execution-profile.js";

describe("Oz execution profiles", () => {
  it("pins the live OpenRouter binding and one logical attempt", () => {
    expect(liveOpenRouterExecutionProfile).toEqual({
      type: "openRouterChatCompletions",
      ref: "oz.openrouter.minimax.minimax-m3.chat-completions.v1",
      modelBinding: "openrouter.chat-completions.minimax.minimax-m3.v1",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "minimax/minimax-m3",
      provider: "Minimax",
      requiredSemantics: {
        output: "text",
        protocol: "chatCompletionsSseV1",
        terminalEnvelope: "[DONE]",
        finishReason: "stop",
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
        maxTokens: 256,
        temperature: 0,
        stream: true,
        reasoning: {
          enabled: true,
          exclude: true,
        },
        provider: {
          only: ["minimax"],
          allowFallbacks: false,
          requireParameters: true,
          dataCollection: "deny",
        },
      },
    });
    expect(Object.isFrozen(liveOpenRouterExecutionProfile)).toBe(true);
    expect(Object.isFrozen(liveOpenRouterExecutionProfile.retry)).toBe(true);
    expect(Object.isFrozen(liveOpenRouterExecutionProfile.request.provider.only)).toBe(true);
  });

  it("keeps the deterministic profile as a distinct binding", () => {
    expect(deterministicExecutionProfile.type).toBe("deterministic");
    expect(deterministicExecutionProfile.ref).toBe("oz.deterministic.v1");
    expect(deterministicExecutionProfile.modelBinding).toBe("oz.deterministic.echo.v1");
    expect(resolveExecutionProfile(deterministicExecutionProfile.ref)).toBe(
      deterministicExecutionProfile,
    );
    expect(resolveExecutionProfile(liveOpenRouterExecutionProfile.ref)).toBe(
      liveOpenRouterExecutionProfile,
    );
  });
});
