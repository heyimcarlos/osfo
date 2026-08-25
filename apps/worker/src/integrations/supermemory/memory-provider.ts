import { BrowserCrypto } from "@effect/platform-browser";
import Supermemory, { APIError } from "supermemory";
import { Crypto, Effect, Encoding, Layer, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import type { SupermemoryConfig } from "../../config";
import { ResourcePriceVersion } from "../../domain";
import { MemoryProvider } from "../../services/memory-provider";

/* oxlint-disable eslint/no-underscore-dangle -- Application-owned outcomes use the _tag discriminator. */

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const SaveConversationRequest = Schema.Struct({
  // Supermemory applies entity context and update deduplication only for this exact stable tag set.
  containerTags: Schema.Tuple([NonEmptyString]),
  conversationId: NonEmptyString,
  messages: Schema.NonEmptyArray(MemoryProvider.ConversationMessage),
});
const SupermemoryDocumentStatus = Schema.Literals([
  "unknown",
  "queued",
  "extracting",
  "chunking",
  "embedding",
  "indexing",
  "done",
  "failed",
]);
const SaveConversationResponse = Schema.Struct({
  conversationId: NonEmptyString,
  id: MemoryProvider.ProviderDocumentId,
  status: Schema.optionalKey(Schema.Unknown),
});
const GetConversationStatusResponse = Schema.Struct({
  id: MemoryProvider.ProviderDocumentId,
  status: Schema.optionalKey(Schema.Unknown),
});
const SessionConversationDocument = Schema.Struct({
  containerTags: Schema.NonEmptyArray(NonEmptyString),
  customId: NonEmptyString,
  id: MemoryProvider.ProviderDocumentId,
});
const SessionConversationDocumentSummary = Schema.Struct({
  containerTags: Schema.NonEmptyArray(NonEmptyString),
  customId: Schema.NullOr(NonEmptyString),
  id: MemoryProvider.ProviderDocumentId,
});
type SessionConversationDocumentSummary = typeof SessionConversationDocumentSummary.Type;
const SessionConversationDocumentsPage = Schema.Struct({
  memories: Schema.Array(SessionConversationDocumentSummary),
  pagination: Schema.Struct({
    currentPage: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    totalItems: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    totalPages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});
const ForgetResponse = Schema.Struct({
  forgotten: Schema.Literal(true),
  id: NonEmptyString,
});
const DeleteUserKnowledgeResponse = Schema.Struct({ success: Schema.Literal(true) });
const ProfileResponse = Schema.Struct({
  profile: Schema.Struct({
    dynamic: Schema.optionalKey(Schema.Array(Schema.String)),
    static: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  searchResults: Schema.optionalKey(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          id: NonEmptyString,
          memory: NonEmptyString,
          similarity: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
          updatedAt: MemoryProvider.EvidenceUpdatedAt,
        }),
      ),
      timing: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
const HybridSearchResult = Schema.Struct({
  chunk: Schema.optionalKey(NonEmptyString),
  id: NonEmptyString,
  memory: Schema.optionalKey(NonEmptyString),
  similarity: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  updatedAt: MemoryProvider.EvidenceUpdatedAt,
}).check(
  Schema.makeFilter(
    ({ chunk, memory }) =>
      (chunk === undefined) !== (memory === undefined) ||
      "must contain exactly one memory or source chunk",
  ),
);
const HybridSearchResponse = Schema.Struct({
  results: Schema.Array(HybridSearchResult),
  timing: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const ConversationSearchabilityResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      chunk: NonEmptyString,
    }),
  ),
});
const OrganizationGuidanceRequest = Schema.Struct({
  filterPrompt: NonEmptyString,
  shouldLLMFilter: Schema.Literal(true),
});
const UserGuidanceRequest = Schema.Struct({ entityContext: NonEmptyString });

const organizationFilterPrompt =
  "Learn durable facts supported by User-authored or User-confirmed statements. Treat assistant messages only as conversational context, never as independent evidence about the User. Reject hypothetical examples and quoted material as User facts. Prefer newer explicit User corrections while retaining temporal context.";
const userEntityContext =
  "This container represents one Osfo User speaking with Osfo. Attribute first-person User statements to that User. Treat named people, organizations, projects, opportunities, and ideas as entities related to the User.";

/** Versioned Supermemory public prices used when per-call evidence is unavailable. */
export interface RateCard {
  readonly ingestionTokenUsdMicros: bigint;
  readonly retrievalUsdMicros: bigint;
  readonly version: ResourcePriceVersion;
}

/** Published Supermemory text-ingestion and retrieval prices pinned for usage evidence. */
export const publicRateCard: RateCard = {
  ingestionTokenUsdMicros: 5n,
  retrievalUsdMicros: 5n,
  version: ResourcePriceVersion.make("resource-prices-2026-08-22"),
};

/** Runtime configuration for the Supermemory MemoryProvider adapter. */
export interface Options {
  readonly apiBaseURL?: string | undefined;
  readonly apiKey: Redacted.Redacted;
  readonly rateCard: RateCard;
}

/** Keep raw SDK access, cancellation, retry policy, and failure translation inside the adapter. */
const makeSdkClient = (options: {
  readonly apiBaseURL: string;
  readonly apiKey: Redacted.Redacted;
}) => {
  const client = new Supermemory({
    apiKey: Redacted.value(options.apiKey),
    baseURL: options.apiBaseURL,
    maxRetries: 0,
  });

  const use = <A>(
    operation: MemoryProvider.MemoryProviderOperation,
    request: (client: Supermemory, signal: AbortSignal) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: (signal) => request(client, signal),
      catch: (cause) => providerFailure(operation, cause),
    });

  const useDeletion = <A>(
    operation: MemoryProvider.MemoryProviderOperation,
    absentStatuses: ReadonlyArray<number>,
    request: (client: Supermemory, signal: AbortSignal) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: (signal) => request(client, signal),
      catch: (cause) => ({ cause, status: cause instanceof APIError ? cause.status : undefined }),
    }).pipe(
      Effect.matchEffect({
        onFailure: ({ cause, status }) =>
          status !== undefined && absentStatuses.includes(status)
            ? Effect.succeed({ _tag: "AlreadyAbsent" } as const)
            : Effect.fail(providerFailure(operation, cause)),
        onSuccess: (response) => Effect.succeed({ _tag: "Response", response } as const),
      }),
    );

  return { use, useDeletion };
};

const make = (options: Options) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const httpClient = yield* HttpClient.HttpClient;
    const apiBaseURL = (options.apiBaseURL ?? "https://api.supermemory.ai").replace(/\/+$/u, "");
    const sdk = makeSdkClient({ apiBaseURL, apiKey: options.apiKey });

    const configure = Effect.fn("SupermemoryMemoryProvider.configure")(function* <
      S extends Schema.Top,
    >(
      operation: Extract<
        MemoryProvider.MemoryProviderOperation,
        "configureOrganizationGuidance" | "configureUserGuidance"
      >,
      url: string,
      schema: S,
      body: S["Type"],
    ) {
      const request = yield* HttpClientRequest.patch(url).pipe(
        HttpClientRequest.bearerToken(options.apiKey),
        HttpClientRequest.schemaBodyJson(schema)(body),
        Effect.mapError(() => providerUnavailable(operation, "requestEncoding")),
      );
      const response = yield* httpClient
        .execute(request)
        .pipe(Effect.mapError(() => providerUnavailable(operation, "transport")));
      if (response.status >= 200 && response.status < 300) return;
      if (operation === "configureUserGuidance" && response.status === 404) {
        // oxlint-disable-next-line typescript/consistent-return -- The yieldable error is a definitive failure exit, not a success value.
        return yield* new MemoryProvider.MemoryProviderUnavailable({
          message: "The MemoryProvider did not upsert the User container",
          operation,
          status: response.status,
        });
      }
      // oxlint-disable-next-line typescript/consistent-return -- The yieldable error is a definitive failure exit, not a success value.
      return yield* providerStatusFailure(operation, response.status);
    });

    const configureOrganizationGuidance = configure(
      "configureOrganizationGuidance",
      `${apiBaseURL}/v3/settings`,
      OrganizationGuidanceRequest,
      { filterPrompt: organizationFilterPrompt, shouldLLMFilter: true },
    );

    const configureUserGuidance = Effect.fn("SupermemoryMemoryProvider.configureUserGuidance")(
      function* (input: MemoryProvider.ConfigureUserGuidanceInput) {
        const containerTag = yield* providerIdentity(
          crypto,
          "u",
          input.userId,
          "configureUserGuidance",
        );
        return yield* configure(
          "configureUserGuidance",
          `${apiBaseURL}/v3/container-tags/${encodeURIComponent(containerTag)}`,
          UserGuidanceRequest,
          { entityContext: userEntityContext },
        );
      },
    );

    const recall = Effect.fn("SupermemoryMemoryProvider.recall")(function* (
      input: MemoryProvider.RecallInput,
    ) {
      const containerTag = yield* providerIdentity(crypto, "u", input.userId, "recall");
      const profileResponse = yield* sdk.use("recall", (client, signal) =>
        client.profile(
          input.mode === "normal" ? { containerTag } : { containerTag, q: input.query },
          { signal },
        ),
      );
      const profile = yield* decodeResponse("recall", ProfileResponse, profileResponse);
      const search =
        input.mode === "normal"
          ? yield* sdk
              .use("recall", (client, signal) =>
                client.search(
                  {
                    containerTag,
                    limit: 20,
                    q: input.query,
                    rerank: false,
                    rewriteQuery: false,
                    searchMode: "hybrid",
                  },
                  { signal },
                ),
              )
              .pipe(
                Effect.flatMap((response) =>
                  decodeResponse("recall", HybridSearchResponse, response),
                ),
              )
          : undefined;
      const profileMemories = profile.searchResults?.results ?? [];
      const hybridResults = search?.results ?? [];
      const relevantMemories = [
        ...profileMemories,
        ...hybridResults.flatMap((result) =>
          result.memory === undefined
            ? []
            : [
                {
                  id: result.id,
                  memory: result.memory,
                  similarity: result.similarity,
                  updatedAt: result.updatedAt,
                },
              ],
        ),
      ];
      return {
        profile: {
          dynamic: profile.profile.dynamic ?? [],
          static: profile.profile.static ?? [],
        },
        relevantMemories: relevantMemories.map((memory) => ({
          content: memory.memory,
          id: MemoryProvider.KnowledgeMemoryId.make(memory.id),
          similarity: memory.similarity,
          updatedAt: memory.updatedAt,
        })),
        sourceChunks: hybridResults.flatMap((result) =>
          result.chunk === undefined
            ? []
            : [
                {
                  content: result.chunk,
                  id: MemoryProvider.SourceChunkId.make(result.id),
                  similarity: result.similarity,
                  updatedAt: result.updatedAt,
                },
              ],
        ),
        usage: {
          completedNonModelCost: [
            {
              activity: "conversationsAndMemory",
              ratedCostUsdMicros:
                options.rateCard.retrievalUsdMicros * (input.mode === "normal" ? 2n : 1n),
              resourcePriceVersion: options.rateCard.version,
            },
          ],
        },
      } satisfies MemoryProvider.RecallResult;
    });

    const saveConversation = Effect.fn("SupermemoryMemoryProvider.saveConversation")(function* (
      input: MemoryProvider.SaveConversationInput,
    ) {
      const [containerTag, conversationId] = yield* Effect.all([
        providerIdentity(crypto, "u", input.userId, "saveConversation"),
        providerIdentity(crypto, "s", input.sessionId, "saveConversation"),
      ]);
      const request = yield* HttpClientRequest.post(`${apiBaseURL}/v4/conversations`).pipe(
        HttpClientRequest.bearerToken(options.apiKey),
        HttpClientRequest.schemaBodyJson(SaveConversationRequest)({
          containerTags: [containerTag],
          conversationId,
          messages: input.conversation.messages,
        }),
        Effect.mapError(() => providerUnavailable("saveConversation", "requestEncoding")),
      );
      const response = yield* httpClient
        .execute(request)
        .pipe(Effect.mapError(() => providerUnavailable("saveConversation", "transport")));
      if (response.status < 200 || response.status >= 300) {
        return yield* providerStatusFailure("saveConversation", response.status);
      }
      const decoded = yield* HttpClientResponse.schemaBodyJson(SaveConversationResponse)(
        response,
      ).pipe(Effect.mapError(() => providerUnavailable("saveConversation", "responseDecoding")));
      if (decoded.conversationId !== conversationId) {
        return yield* providerUnavailable("saveConversation", "identityMismatch");
      }
      const ingestionTokens = BigInt(
        input.conversation.messages
          .slice(input.conversation.usageStartIndex)
          .reduce(
            (total, message) =>
              total + new TextEncoder().encode(`${message.role}\n${message.content}`).byteLength,
            0,
          ),
      );
      const usage = {
        completedNonModelCost: [
          {
            activity: "conversationsAndMemory",
            ratedCostUsdMicros: ingestionTokens * options.rateCard.ingestionTokenUsdMicros,
            resourcePriceVersion: options.rateCard.version,
          },
        ],
      } satisfies MemoryProvider.UsageEvidence;
      const processingStatus = yield* decodeConversationProcessingStatus(
        "saveConversation",
        decoded.status,
        () =>
          new MemoryProvider.MemoryProviderAcceptanceStatusInvalid({
            documentId: decoded.id,
            message: "The MemoryProvider accepted the conversation with an invalid status",
            operation: "saveConversation",
            usage,
          }),
      );
      return {
        documentId: decoded.id,
        processingStatus,
        usage,
      } satisfies MemoryProvider.SaveConversationResult;
    });

    const getConversationStatus = Effect.fn("SupermemoryMemoryProvider.getConversationStatus")(
      function* (input: MemoryProvider.GetConversationStatusInput) {
        const response = yield* sdk.use("getConversationStatus", (client, signal) =>
          client.documents.get(input.documentId, { signal }),
        );
        const decoded = yield* decodeResponse(
          "getConversationStatus",
          GetConversationStatusResponse,
          response,
        );
        if (decoded.id !== input.documentId) {
          return yield* providerUnavailable("getConversationStatus", "identityMismatch");
        }
        const processingStatus = yield* decodeConversationProcessingStatus(
          "getConversationStatus",
          decoded.status,
          () => providerUnavailable("getConversationStatus", "responseDecoding"),
        );
        return {
          processingStatus,
        } satisfies MemoryProvider.GetConversationStatusResult;
      },
    );

    const checkConversationSearchability = Effect.fn(
      "SupermemoryMemoryProvider.checkConversationSearchability",
    )(function* (input: MemoryProvider.CheckConversationSearchabilityInput) {
      const containerTag = yield* providerIdentity(
        crypto,
        "u",
        input.userId,
        "checkConversationSearchability",
      );
      const response = yield* sdk.use("checkConversationSearchability", (client, signal) =>
        client.search(
          {
            containerTag,
            limit: 20,
            q: input.expectedSource,
            rerank: false,
            rewriteQuery: false,
            searchMode: "documents",
            threshold: 0,
          },
          { signal },
        ),
      );
      const decoded = yield* decodeResponse(
        "checkConversationSearchability",
        ConversationSearchabilityResponse,
        response,
      );
      return decoded.results.some(({ chunk }) => chunk.includes(input.expectedSource));
    });

    const forgetKnowledge = Effect.fn("SupermemoryMemoryProvider.forgetKnowledge")(function* (
      input: MemoryProvider.ForgetKnowledgeInput,
    ) {
      const containerTag = yield* providerIdentity(crypto, "u", input.userId, "forgetKnowledge");
      const results = yield* Effect.forEach(
        input.memoryIds,
        (id) =>
          sdk
            .useDeletion("forgetKnowledge", [404, 409], (client, signal) =>
              client.memories.forget({ containerTag, id }, { signal }),
            )
            .pipe(
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  MemoryProvider.DeletionResult,
                  MemoryProvider.MemoryProviderUnavailable
                > => {
                  if (result._tag === "AlreadyAbsent") return Effect.succeed(result);
                  return decodeResponse("forgetKnowledge", ForgetResponse, result.response).pipe(
                    Effect.as({ _tag: "Deleted" } as const),
                  );
                },
              ),
            ),
        { concurrency: 1 },
      );
      return results.some((result) => result._tag === "Deleted")
        ? ({ _tag: "Deleted" } as const)
        : ({ _tag: "AlreadyAbsent" } as const);
    });

    const deleteSessionConversation = Effect.fn(
      "SupermemoryMemoryProvider.deleteSessionConversation",
    )(function* (input: MemoryProvider.DeleteSessionConversationInput) {
      const [containerTag, customId] = yield* Effect.all([
        providerIdentity(crypto, "u", input.userId, "deleteSessionConversation"),
        providerIdentity(crypto, "s", input.sessionId, "deleteSessionConversation"),
      ]);
      let candidate: SessionConversationDocumentSummary | undefined;
      let page = 1;
      while (true) {
        const response = yield* sdk.use("deleteSessionConversation", (client, signal) =>
          client.documents.list({ containerTags: [containerTag], limit: 100, page }, { signal }),
        );
        const decoded = yield* decodeResponse(
          "deleteSessionConversation",
          SessionConversationDocumentsPage,
          response,
        );
        if (
          decoded.pagination.currentPage !== page ||
          (decoded.pagination.totalPages > 0 && decoded.pagination.totalPages < page)
        ) {
          return yield* providerUnavailable("deleteSessionConversation", "responseDecoding");
        }
        const matches = decoded.memories.filter((document) => document.customId === customId);
        if (
          matches.length > 1 ||
          (candidate !== undefined && matches.length === 1) ||
          matches.some((document) => !belongsOnlyToUser(document.containerTags, containerTag))
        ) {
          return yield* providerUnavailable("deleteSessionConversation", "identityMismatch");
        }
        candidate = matches[0] ?? candidate;
        if (page >= decoded.pagination.totalPages) break;
        page += 1;
      }
      if (candidate === undefined) return { _tag: "AlreadyAbsent" } as const;
      const lookup = yield* sdk.useDeletion("deleteSessionConversation", [404], (client, signal) =>
        client.documents.get(candidate.id, { signal }),
      );
      if (lookup._tag === "AlreadyAbsent") return lookup;
      const document = yield* decodeResponse(
        "deleteSessionConversation",
        SessionConversationDocument,
        lookup.response,
      );
      if (
        document.id !== candidate.id ||
        document.customId !== customId ||
        !belongsOnlyToUser(document.containerTags, containerTag)
      ) {
        return yield* providerUnavailable("deleteSessionConversation", "identityMismatch");
      }
      const result = yield* sdk.useDeletion("deleteSessionConversation", [404], (client, signal) =>
        client.documents.delete(document.id, { signal }),
      );
      return result._tag === "AlreadyAbsent" ? result : ({ _tag: "Deleted" } as const);
    });

    const deleteUserKnowledge = Effect.fn("SupermemoryMemoryProvider.deleteUserKnowledge")(
      function* (input: MemoryProvider.DeleteUserKnowledgeInput) {
        const containerTag = yield* providerIdentity(
          crypto,
          "u",
          input.userId,
          "deleteUserKnowledge",
        );
        const request = HttpClientRequest.delete(
          `${apiBaseURL}/v3/container-tags/${encodeURIComponent(containerTag)}`,
        ).pipe(HttpClientRequest.bearerToken(options.apiKey));
        const response = yield* httpClient.execute(request).pipe(
          Effect.mapError(
            () =>
              new MemoryProvider.MemoryProviderUnavailable({
                message: "The MemoryProvider is unavailable",
                operation: "deleteUserKnowledge",
              }),
          ),
        );
        if (response.status === 404) return { _tag: "AlreadyAbsent" } as const;
        if (response.status >= 200 && response.status < 300) {
          yield* HttpClientResponse.schemaBodyJson(DeleteUserKnowledgeResponse)(response).pipe(
            Effect.mapError(() => providerUnavailable("deleteUserKnowledge", "responseDecoding")),
          );
          return { _tag: "Deleted" } as const;
        }
        return yield* providerStatusFailure("deleteUserKnowledge", response.status);
      },
    );

    return MemoryProvider.Service.of({
      checkConversationSearchability,
      configureOrganizationGuidance,
      configureUserGuidance,
      deleteSessionConversation,
      deleteUserKnowledge,
      forgetKnowledge,
      getConversationStatus,
      recall,
      saveConversation,
    });
  });

/** Supermemory adapter Layer that preserves HTTP and cryptography dependencies. */
export const layerWithoutDependencies = (options: Options) =>
  Layer.effect(MemoryProvider.Service, make(options));

/** Supermemory adapter Layer backed by Worker fetch and browser cryptography. */
export const layer = (options: Options) =>
  layerWithoutDependencies(options).pipe(
    Layer.provide(Layer.merge(BrowserCrypto.layer, FetchHttpClient.layer)),
  );

/** Production Supermemory MemoryProvider Layer from parsed Worker configuration. */
export const layerFromConfig = (config: SupermemoryConfig) =>
  layer({
    apiBaseURL: config.apiBaseURL,
    apiKey: config.apiKey,
    rateCard: publicRateCard,
  });

const belongsOnlyToUser = (containerTags: ReadonlyArray<string>, expectedUserTag: string) => {
  // Stable Osfo User containers are `u_` identities; other non-User grouping tags do not own data.
  const userTags = containerTags.filter((containerTag) => containerTag.startsWith("u_"));
  return userTags.length === 1 && userTags[0] === expectedUserTag;
};

const providerIdentity = (
  crypto: Crypto.Crypto,
  prefix: "s" | "u",
  identity: string,
  operation: MemoryProvider.MemoryProviderOperation,
) =>
  crypto.digest("SHA-256", new TextEncoder().encode(identity)).pipe(
    Effect.map((digest) => `${prefix}_${Encoding.encodeBase64Url(digest)}`),
    Effect.mapError(
      () =>
        new MemoryProvider.MemoryProviderUnavailable({
          message: "A provider-safe MemoryProvider identity could not be derived",
          operation,
        }),
    ),
  );

const providerRejected = (operation: MemoryProvider.MemoryProviderOperation) =>
  new MemoryProvider.MemoryProviderRejected({
    message: "The MemoryProvider rejected the operation",
    operation,
  });

/** Supermemory `done` ends processing but does not guarantee hybrid-search visibility. */
const decodeConversationProcessingStatus = <E>(
  operation: MemoryProvider.MemoryProviderOperation,
  // oxlint-disable-next-line osfo/no-unknown-parameters -- Status is isolated from an otherwise valid provider identity before it is decoded.
  status: unknown,
  invalid: () => E,
): Effect.Effect<
  MemoryProvider.ConversationProcessingStatus,
  E | MemoryProvider.MemoryProviderRejected
> =>
  Schema.decodeUnknownEffect(SupermemoryDocumentStatus)(status).pipe(
    Effect.mapError(invalid),
    Effect.flatMap((decoded) =>
      decoded === "failed"
        ? Effect.fail(providerRejected(operation))
        : Effect.succeed(decoded === "done" ? "done" : "processing"),
    ),
  );

const decodeResponse = <S extends Schema.Top>(
  operation: MemoryProvider.MemoryProviderOperation,
  schema: S,
  // oxlint-disable-next-line osfo/no-unknown-parameters -- The adapter owns decoding of every untrusted provider response.
  response: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(response).pipe(
    Effect.mapError(
      () =>
        new MemoryProvider.MemoryProviderUnavailable({
          diagnostic: "responseDecoding",
          message: "The MemoryProvider returned an invalid response",
          operation,
        }),
    ),
  );

const providerFailure = (
  operation: MemoryProvider.MemoryProviderOperation,
  cause: unknown,
): MemoryProvider.MemoryProviderRejected | MemoryProvider.MemoryProviderUnavailable => {
  const status = cause instanceof APIError ? cause.status : undefined;
  if (status !== undefined) return providerStatusFailure(operation, status);
  return new MemoryProvider.MemoryProviderUnavailable({
    diagnostic: "transport",
    message: "The MemoryProvider is unavailable",
    operation,
  });
};

const providerStatusFailure = (
  operation: MemoryProvider.MemoryProviderOperation,
  status: number,
): MemoryProvider.MemoryProviderRejected | MemoryProvider.MemoryProviderUnavailable =>
  status >= 400 && status < 500 && status !== 408 && status !== 429
    ? new MemoryProvider.MemoryProviderRejected({
        message: "The MemoryProvider rejected the operation",
        operation,
        status,
      })
    : new MemoryProvider.MemoryProviderUnavailable({
        message: "The MemoryProvider is unavailable",
        operation,
        status,
      });

const providerUnavailable = (
  operation: MemoryProvider.MemoryProviderOperation,
  diagnostic: MemoryProvider.MemoryProviderDiagnostic,
) =>
  new MemoryProvider.MemoryProviderUnavailable({
    diagnostic,
    message:
      diagnostic === "identityMismatch" || diagnostic === "responseDecoding"
        ? "The MemoryProvider returned an invalid response"
        : "The MemoryProvider is unavailable",
    operation,
  });

export * as SupermemoryMemoryProvider from "./memory-provider";
