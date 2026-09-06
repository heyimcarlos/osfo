import { Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import type { ResearchReportProviderConfig } from "../../config";
import { managedSearchAdmissionUsdMicros } from "../../domain/web-search-price";
import { ResearchSynthesis } from "../../services/research-synthesis";
import { canonicalPublicUrl, isSafePublicUrl, type PageFetch } from "../../services/web";
import { ResearchSynthesisProvider } from "./research-synthesis-provider";
import { ManagedWebSearch } from "./managed-web-search";
import {
  hasRecognizedWebSearchPrice,
  makeDiscovery,
  makePageFetch,
  WebProviderUnavailable,
} from "./web";

/* oxlint-disable eslint/no-underscore-dangle -- Effect and provider outcomes use the standard _tag discriminator. */

const bounded = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

const DiscoveryResponse = Schema.Struct({
  requestId: bounded(512),
  results: Schema.Array(Schema.Struct({ title: bounded(2_000), url: bounded(4_096) })).check(
    Schema.isMaxLength(10),
  ),
});

const PageResponse = Schema.Struct({
  content: bounded(256_000),
  contentType: bounded(512),
  finalUrl: bounded(4_096),
  status: Schema.Int,
  title: Schema.NullOr(bounded(2_000)),
});

const SynthesisEnvelope = Schema.Struct({ result: Schema.Unknown });
const DiscoveryRequest = Schema.Struct({ limit: Schema.Int, query: Schema.String });
const PageRequest = Schema.Struct({ url: Schema.String });
const SynthesisRequest = Schema.Struct({
  operationId: ResearchSynthesis.OperationId,
  sources: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      sourceId: Schema.String,
      title: Schema.NullOr(Schema.String),
    }),
  ),
  topic: Schema.String,
});

class LocalVerificationUnavailable extends Schema.TaggedError<LocalVerificationUnavailable>()(
  "LocalResearchVerificationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Deterministic, loopback-only provider used by the browser verification harness. */
export const make = (
  config: Extract<ResearchReportProviderConfig, { readonly _tag: "LocalVerification" }>,
) => {
  return {
    discover: (query: string, limit: number) =>
      requestJson(
        config.baseURL,
        "/_local/research/discover",
        DiscoveryRequest,
        DiscoveryResponse,
        {
          limit,
          query,
        },
      ).pipe(
        Effect.flatMap((response) =>
          Effect.forEach(response.results, ({ title, url }) =>
            isSafePublicUrl(url)
              ? Effect.succeed({ title, url: canonicalPublicUrl(url) })
              : Effect.fail(
                  new LocalVerificationUnavailable({
                    cause: url,
                    message: "Local Research discovery returned an unsafe URL",
                  }),
                ),
          ).pipe(
            Effect.map((results) => ({
              evidence: { latencyMs: 0, requestId: response.requestId },
              results,
            })),
          ),
        ),
        Effect.mapError(
          () =>
            new WebProviderUnavailable({
              message: "Local Research discovery was unavailable or invalid.",
              operation: "discover",
              retry: "ambiguous",
            }),
        ),
      ),
    fetchPage: ({ url }: { readonly url: string }) =>
      requestJson(config.baseURL, "/_local/research/page", PageRequest, PageResponse, {
        url,
      }).pipe(
        Effect.flatMap((page) => validatePage(url, page)),
        Effect.mapError(
          () =>
            new WebProviderUnavailable({
              message: "Local Research page retrieval was unavailable or invalid.",
              operation: "fetch",
              retry: "transient",
            }),
        ),
      ),
    synthesize: {
      generate: (input: Parameters<ResearchSynthesis.PortInterface["provider"]["generate"]>[0]) =>
        requestJson(
          config.baseURL,
          "/_local/research/synthesize",
          SynthesisRequest,
          SynthesisEnvelope,
          {
            operationId: input.operationId,
            sources: input.sources.map(({ content, source }) => ({
              content,
              sourceId: source.sourceId,
              title: source.title,
            })),
            topic: input.topic,
          },
        ).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Effect.succeed({
                _tag: "Unknown" as const,
                companyCost: zeroCost(input.operationId),
              }),
            onSuccess: (response) =>
              Schema.decodeUnknownEffect(ResearchSynthesis.Result)(response.result).pipe(
                Effect.match({
                  onFailure: () => ({
                    _tag: "Completed" as const,
                    companyCost: zeroCost(input.operationId),
                    result: null,
                  }),
                  onSuccess: (result) => ({
                    _tag: "Completed" as const,
                    companyCost: zeroCost(input.operationId),
                    result,
                  }),
                }),
              ),
          }),
        ),
    } satisfies ResearchSynthesis.PortInterface["provider"],
  };
};

/** Select the isolated local verifier or the ordinary Cloudflare discovery boundary. */
export const selectDiscovery = (
  config: ResearchReportProviderConfig,
  binding: Pick<WebSearch, "search">,
  ai?: Pick<Ai, "run">,
) => {
  if (config._tag === "LocalVerification") return make(config).discover;
  if (config._tag === "ManagedWebSearch") {
    if (ai === undefined) {
      return () =>
        Effect.fail(
          new WebProviderUnavailable({
            message: "The managed search AI binding is missing.",
            operation: "discover",
            retry: "never",
          }),
        );
    }
    return ManagedWebSearch.makeDiscovery(ai, config.gatewayId);
  }
  return makeDiscovery(binding);
};

/** Select the isolated local verifier or the ordinary public-page fetch boundary. */
export const selectPageFetch = (config: ResearchReportProviderConfig) =>
  config._tag === "LocalVerification" ? make(config).fetchPage : makePageFetch();

/** Select the isolated local verifier or the ordinary Workers AI synthesis boundary. */
export const selectSynthesis = (config: ResearchReportProviderConfig, binding: Ai) =>
  config._tag === "LocalVerification"
    ? make(config).synthesize
    : ResearchSynthesisProvider.make(binding);

/** A local verifier is explicit no-cost evidence; Cloudflare stays fail-closed until priced. */
export const isAvailable = (config: ResearchReportProviderConfig) =>
  config._tag === "LocalVerification" ||
  config._tag === "ManagedWebSearch" ||
  hasRecognizedWebSearchPrice;

/** Paid dispatch retains the same conservative admission allowance used by managed work. */
export const selectSearchPolicy = (config: ResearchReportProviderConfig) =>
  config._tag === "ManagedWebSearch"
    ? { requestVendorUsdMicros: managedSearchAdmissionUsdMicros }
    : undefined;

/** Supply Think's Workers AI boundary only inside the explicit local verifier. */
export const makeAiBinding = (
  config: Extract<ResearchReportProviderConfig, { readonly _tag: "LocalVerification" }>,
): Ai => {
  const boundary = {
    aiGatewayLogId: null,
    run: (_model: string, inputs: Schema.Json) =>
      Effect.runPromise(
        requestUnknownJson(config.baseURL, "/_local/research/agent", Schema.Json, inputs),
      ),
  };
  // SAFETY: workers-ai-provider reads only `run` and `aiGatewayLogId` on this binding. The
  // loopback-only configuration guard prevents the deliberately narrow shim from production use.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The preceding runtime ownership proof is intentionally narrower than Cloudflare's full binding.
  return boundary as Ai;
};

const validatePage = (requestedUrl: string, page: typeof PageResponse.Type) => {
  if (!isSafePublicUrl(page.finalUrl)) {
    return Effect.fail(
      new LocalVerificationUnavailable({
        cause: page.finalUrl,
        message: "Local Research page returned an unsafe final URL",
      }),
    );
  }
  const finalUrl = canonicalPublicUrl(page.finalUrl);
  if (finalUrl !== canonicalPublicUrl(requestedUrl)) {
    return Effect.fail(
      new LocalVerificationUnavailable({
        cause: page.finalUrl,
        message: "Local Research page identity changed",
      }),
    );
  }
  const bytes = BigInt(new TextEncoder().encode(page.content).byteLength);
  return Effect.succeed({
    ...page,
    fetchedBytes: bytes,
    finalUrl,
    normalizedBytes: bytes,
    redirects: [],
  } satisfies PageFetch);
};

const requestJson = <Request extends Schema.Top, Response extends Schema.Top>(
  baseURL: string,
  path: string,
  requestSchema: Request,
  responseSchema: Response,
  body: Request["Type"],
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(new URL(path, baseURL).href).pipe(
      HttpClientRequest.schemaBodyJson(requestSchema)(body),
    );
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* new LocalVerificationUnavailable({
        cause: response.status,
        message: "The local Research provider returned a non-success status",
      });
    }
    return yield* HttpClientResponse.schemaBodyJson(responseSchema)(response);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new LocalVerificationUnavailable({
          cause,
          message: "The local Research provider request failed",
        }),
    ),
    // This adapter is the owning local-only HTTP composition boundary and closes the client layer.
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The returned provider ports intentionally expose no transport dependency.
    Effect.provide(FetchHttpClient.layer),
  );

const requestUnknownJson = <Response extends Schema.Top>(
  baseURL: string,
  path: string,
  responseSchema: Response,
  body: Schema.Json,
) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body);
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(new URL(path, baseURL).href).pipe(
      HttpClientRequest.bodyText(encoded, "application/json"),
    );
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* new LocalVerificationUnavailable({
        cause: response.status,
        message: "The local Research provider returned a non-success status",
      });
    }
    return yield* HttpClientResponse.schemaBodyJson(responseSchema)(response);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new LocalVerificationUnavailable({
          cause,
          message: "The local Research provider request failed",
        }),
    ),
    // This adapter is the owning local-only HTTP composition boundary and closes the client layer.
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The returned provider ports intentionally expose no transport dependency.
    Effect.provide(FetchHttpClient.layer),
  );

const zeroCost = (providerOperationId: ResearchSynthesis.OperationId) => ({
  basis: "observed" as const,
  inputTokens: 0n,
  outputTokens: 0n,
  providerOperationId,
  usdMicros: 0n,
});

export * as ResearchVerificationProvider from "./research-verification-provider";
