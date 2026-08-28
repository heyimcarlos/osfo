import { generateText, jsonSchema, NoObjectGeneratedError, Output } from "ai";
import { Effect, Schema } from "effect";
import { createWorkersAI } from "workers-ai-provider";

import { launchModelAccessPolicy } from "../../domain/model-access-policy";
import { managedModelRoutinePrice } from "../../domain/usage";
import { ResearchSynthesis } from "../../services/research-synthesis";

/* oxlint-disable effecttsgo/async-function -- AI SDK providers expose Promise-only calls. */

const maximumInputTokens = launchModelAccessPolicy.plans.free.context.targetInputTokens;
const maximumOutputTokens = launchModelAccessPolicy.plans.free.context.maxOutputTokens;

/** One no-retry structured model adapter over the exact route pinned at admission. */
export const make = (binding: Ai): ResearchSynthesis.PortInterface["provider"] => ({
  generate: (input) => {
    const conservative = companyCost(
      input.operationId,
      BigInt(maximumInputTokens),
      BigInt(maximumOutputTokens),
      "conservative",
    );
    return Effect.tryPromise({
      try: () =>
        generateText({
          maxOutputTokens: maximumOutputTokens,
          maxRetries: 0,
          model: createWorkersAI({ binding })(input.modelRoute),
          output: Output.object({ schema: effectSchema(ResearchSynthesis.Result) }),
          prompt: promptFor(input),
          system:
            "Write a bounded research report from only the supplied fetched pages. Return material claims as structured claims with exact source IDs and verbatim supporting quotes. Do not output URLs, content digests, unsupported facts, or discovery snippets. Every summary, section, and conclusion claim must have evidence.",
          timeout: 30_000,
        }),
      catch: (cause) => ({ cause }),
    }).pipe(
      Effect.match({
        onFailure: ({ cause }) => classifyFailure(input.operationId, cause, conservative),
        onSuccess: (generated) => {
          const inputTokens = BigInt(generated.usage.inputTokens ?? maximumInputTokens);
          const outputTokens = BigInt(generated.usage.outputTokens ?? maximumOutputTokens);
          const measured =
            generated.usage.inputTokens !== undefined && generated.usage.outputTokens !== undefined;
          return {
            _tag: "Completed" as const,
            companyCost: companyCost(
              input.operationId,
              inputTokens,
              outputTokens,
              measured ? "observed" : "conservative",
            ),
            result: generated.output,
          };
        },
      }),
    );
  },
});

/** Separate deterministic structured-output rejection from ambiguous provider acceptance. */
export const classifyFailure = (
  operationId: ResearchSynthesis.OperationId,
  cause: unknown,
  conservative: ResearchSynthesis.CompanyCost,
):
  | {
      readonly _tag: "Completed";
      readonly companyCost: ResearchSynthesis.CompanyCost;
      readonly result: null;
    }
  | { readonly _tag: "Unknown"; readonly companyCost: ResearchSynthesis.CompanyCost } => {
  if (!NoObjectGeneratedError.isInstance(cause)) {
    return { _tag: "Unknown", companyCost: conservative };
  }
  const measured = cause.usage?.inputTokens !== undefined && cause.usage.outputTokens !== undefined;
  const inputTokens = BigInt(cause.usage?.inputTokens ?? maximumInputTokens);
  const outputTokens = BigInt(cause.usage?.outputTokens ?? maximumOutputTokens);
  return {
    _tag: "Completed",
    companyCost: companyCost(
      operationId,
      inputTokens,
      outputTokens,
      measured ? "observed" : "conservative",
    ),
    result: null,
  };
};

const promptFor = (input: Parameters<ResearchSynthesis.PortInterface["provider"]["generate"]>[0]) =>
  JSON.stringify({
    requiredReport: {
      conclusion: "1-5 cited material claims",
      sections: "1-8 sections, each with 1-10 cited material claims",
      summary: "1-5 cited material claims",
      title: "descriptive title",
    },
    sources: input.sources.map(({ content, source }) => ({
      content,
      sourceId: source.sourceId,
      title: source.title,
    })),
    topic: input.topic,
  });

const companyCost = (
  providerOperationId: ResearchSynthesis.OperationId,
  inputTokens: bigint,
  outputTokens: bigint,
  basis: ResearchSynthesis.CompanyCost["basis"],
): ResearchSynthesis.CompanyCost => ({
  basis,
  inputTokens,
  outputTokens,
  providerOperationId,
  usdMicros:
    rate(inputTokens, managedModelRoutinePrice.inputUsdMicrosPerMillionTokens) +
    rate(outputTokens, managedModelRoutinePrice.outputUsdMicrosPerMillionTokens),
});

const rate = (tokens: bigint, usdMicrosPerMillionTokens: bigint) => {
  const numerator = tokens * usdMicrosPerMillionTokens;
  return numerator === 0n ? 0n : (numerator + 999_999n) / 1_000_000n;
};

const effectSchema = <Value, Encoded>(schema: Schema.Codec<Value, Encoded>) => {
  const document = Schema.toJsonSchemaDocument(schema);
  const providerSchema =
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions };
  return jsonSchema<Value>(providerSchema, {
    validate: (value) =>
      Effect.runPromise(
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.match({
            onFailure: (error) => ({ error, success: false }) as const,
            onSuccess: (decoded) => ({ success: true, value: decoded }) as const,
          }),
        ),
      ),
  });
};

export * as ResearchSynthesisProvider from "./research-synthesis-provider";
