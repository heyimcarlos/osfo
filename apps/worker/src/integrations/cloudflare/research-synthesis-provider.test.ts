/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
/* oxlint-disable effecttsgo/global-date -- Fixed provider response metadata is immutable evidence. */
import { expect, it } from "@effect/vitest";
import { NoObjectGeneratedError } from "ai";
import { Effect } from "effect";

import { ResearchSynthesis } from "../../services/research-synthesis";
import { ResearchSynthesisProvider } from "./research-synthesis-provider";

const operationId = ResearchSynthesis.OperationId.make("provider-classification");
const responseTimestamp = new Date("2026-08-27T12:00:00.000Z");
const conservative: ResearchSynthesis.CompanyCost = {
  basis: "conservative",
  inputTokens: 1n,
  outputTokens: 1n,
  providerOperationId: operationId,
  usdMicros: 1n,
};

it.effect("classifies structured-output schema rejection as deterministic invalid output", () =>
  Effect.sync(() => {
    const failure = new NoObjectGeneratedError({
      finishReason: "stop",
      response: {
        id: "response-id",
        modelId: "model-id",
        timestamp: responseTimestamp,
      },
      text: "not valid structured output",
      usage: {
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          noCacheTokens: 12,
        },
        inputTokens: 12,
        outputTokenDetails: { reasoningTokens: 0, textTokens: 7 },
        outputTokens: 7,
        totalTokens: 19,
      },
    });

    expect(
      ResearchSynthesisProvider.classifyFailure(operationId, failure, conservative),
    ).toMatchObject({
      _tag: "Completed",
      companyCost: { basis: "observed", inputTokens: 12n, outputTokens: 7n },
      result: null,
    });
  }),
);

it.effect("keeps connection or acknowledgement rejection ambiguous", () =>
  Effect.sync(() => {
    expect(
      ResearchSynthesisProvider.classifyFailure(
        operationId,
        new Error("connection ended"),
        conservative,
      ),
    ).toEqual({ _tag: "Unknown", companyCost: conservative });
  }),
);
