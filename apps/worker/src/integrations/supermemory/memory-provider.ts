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
import { MemoryProvider } from "../../services/memory-provider";

/* oxlint-disable eslint/no-underscore-dangle -- Application-owned outcomes use the _tag discriminator. */

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const SaveConversationRequest = Schema.Struct({
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
  searchResults: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        id: NonEmptyString,
        memory: NonEmptyString,
        similarity: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      }),
    ),
    timing: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});

/** Versioned Supermemory public prices used when per-call evidence is unavailable. */
export interface RateCard {
  readonly ingestionTokenUsdMicros: bigint;
  readonly retrievalUsdMicros: bigint;
  readonly version: string;
}

/** Published Supermemory text-ingestion and retrieval prices pinned for usage evidence. */
export const publicRateCard: RateCard = {
  ingestionTokenUsdMicros: 5n,
  retrievalUsdMicros: 5n,
  version: "supermemory-public-2026-08-22",
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

    const recall = Effect.fn("SupermemoryMemoryProvider.recall")(function* (
      input: MemoryProvider.RecallInput,
    ) {
      const containerTag = yield* providerIdentity(crypto, "u", input.userId, "recall");
      const response = yield* sdk.use("recall", (client, signal) =>
        client.profile({ containerTag, q: input.query }, { signal }),
      );
      const decoded = yield* decodeResponse("recall", ProfileResponse, response);
      return {
        profile: {
          dynamic: decoded.profile.dynamic ?? [],
          static: decoded.profile.static ?? [],
        },
        relevantMemories: decoded.searchResults.results.map((memory) => ({
          content: memory.memory,
          id: MemoryProvider.KnowledgeMemoryId.make(memory.id),
          similarity: memory.similarity,
        })),
        usage: {
          items: [
            {
              allowanceKind: "supermemoryRetrievals",
              basis: "known_at_start",
              quantity: 1n,
            },
            {
              allowanceKind: "vendorUsdMicros",
              basis: "known_at_start",
              quantity: options.rateCard.retrievalUsdMicros,
            },
          ],
          rateCardVersion: options.rateCard.version,
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
        items: [
          {
            allowanceKind: "supermemoryIngestionTokens",
            basis: "conservative",
            quantity: ingestionTokens,
          },
          {
            allowanceKind: "vendorUsdMicros",
            basis: "conservative",
            quantity: ingestionTokens * options.rateCard.ingestionTokenUsdMicros,
          },
        ],
        rateCardVersion: options.rateCard.version,
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
      const customId = yield* providerIdentity(
        crypto,
        "s",
        input.sessionId,
        "deleteSessionConversation",
      );
      const result = yield* sdk.useDeletion("deleteSessionConversation", [404], (client, signal) =>
        client.documents.delete(customId, { signal }),
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

/**
 * Supermemory's documented pipeline treats every state before `done` as processing and says
 * `done` makes the document path ready for search. That is the qualified ordering-release
 * boundary; later memory dreaming remains outside this ingestion barrier.
 * https://supermemory.ai/docs/concepts/how-it-works#what-the-pipeline-does
 */
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
