/* oxlint-disable effecttsgo/async-function -- Node HTTP request streams are Promise boundaries in this provider emulator. */
/* oxlint-disable effecttsgo/node-builtin-import -- The adapter contract test uses a scoped local provider emulator. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the application entry point for its isolated adapter Layer. */
/* oxlint-disable eslint/no-underscore-dangle -- Application outcomes use the _tag discriminator. */
/* oxlint-disable osfo/no-runtime-typeof -- Node's listen callback returns a documented string-or-address representation. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";

import { SessionId, UserId } from "../../domain";
import { MemoryProvider } from "../../services/memory-provider";
import { PromptAssembly } from "../../services/prompt-assembly";
import { SupermemoryMemoryProvider } from "./memory-provider";

it.effect("recalls User-scoped profile and relevant Knowledge Base evidence", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          profile: {
            dynamic: ["Deploying the first service"],
            static: ["Prefers small releases"],
          },
          searchResults: {
            results: [
              {
                id: "memory-1",
                memory: "Production deploys require approval",
                metadata: null,
                similarity: 0.91,
                updatedAt: "2026-08-22T12:00:00.000Z",
                version: 1,
              },
            ],
            timing: 12,
            total: 1,
          },
        },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const result = yield* memory.recall({
        query: "What should I remember about deployment?",
        userId: UserId.make("user:with/provider-invalid characters"),
      });

      expect(result).toEqual({
        profile: {
          dynamic: ["Deploying the first service"],
          static: ["Prefers small releases"],
        },
        relevantMemories: [
          {
            content: "Production deploys require approval",
            id: "memory-1",
            similarity: 0.91,
          },
        ],
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
              quantity: 5n,
            },
          ],
          rateCardVersion: "supermemory-public-2026-08-22",
        },
      });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTag: "u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY",
            q: "What should I remember about deployment?",
          },
          method: "POST",
          path: "/v4/profile",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("saves one structured Session conversation with conservative usage evidence", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          conversationId: "s_rOWDOMu6gfHVler-5_5Pqai1QTLVqrovuxZcQccEncE",
          id: "document-1",
          status: "queued",
        },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const result = yield* memory.saveConversation({
        conversation: MemoryProvider.ConversationSnapshot.make({
          messages: [
            { content: "Earlier question", role: "user" },
            { content: "Earlier answer", role: "assistant" },
            { content: "Hello 👋", role: "user" },
            { content: "Hi", role: "assistant" },
          ],
          usageStartIndex: 2,
        }),
        sessionId: SessionId.make("session:with/provider-invalid characters"),
        userId: UserId.make("user:with/provider-invalid characters"),
      });

      expect(result).toEqual({
        usage: {
          items: [
            {
              allowanceKind: "supermemoryIngestionTokens",
              basis: "conservative",
              quantity: 27n,
            },
            {
              allowanceKind: "vendorUsdMicros",
              basis: "conservative",
              quantity: 135n,
            },
          ],
          rateCardVersion: "supermemory-public-2026-08-22",
        },
      });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTags: ["u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY"],
            conversationId: "s_rOWDOMu6gfHVler-5_5Pqai1QTLVqrovuxZcQccEncE",
            messages: [
              { content: "Earlier question", role: "user" },
              { content: "Earlier answer", role: "assistant" },
              { content: "Hello 👋", role: "user" },
              { content: "Hi", role: "assistant" },
            ],
          },
          method: "POST",
          path: "/v4/conversations",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("forgets only exact approved memory IDs within the User scope", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        { body: { forgotten: true, id: "memory-1" }, status: 200 },
        { body: { forgotten: true, id: "memory-2" }, status: 200 },
      );
      const memory = yield* MemoryProvider.Service;
      const result = yield* memory.forgetKnowledge({
        memoryIds: [
          MemoryProvider.KnowledgeMemoryId.make("memory-1"),
          MemoryProvider.KnowledgeMemoryId.make("memory-2"),
        ],
        userId: UserId.make("user:with/provider-invalid characters"),
      });

      expect(result).toEqual({ _tag: "Deleted" });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTag: "u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY",
            id: "memory-1",
          },
          method: "DELETE",
          path: "/v4/memories",
        },
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTag: "u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY",
            id: "memory-2",
          },
          method: "DELETE",
          path: "/v4/memories",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("deletes one Session conversation by its stable provider identity", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({ status: 204 });
      const memory = yield* MemoryProvider.Service;
      const result = yield* memory.deleteSessionConversation({
        sessionId: SessionId.make("session:with/provider-invalid characters"),
        userId: UserId.make("user:with/provider-invalid characters"),
      });

      expect(result).toEqual({ _tag: "Deleted" });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: undefined,
          method: "DELETE",
          path: "/v3/documents/s_rOWDOMu6gfHVler-5_5Pqai1QTLVqrovuxZcQccEncE",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("keeps a processing conflict retryable when deleting a Session conversation", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({ body: { error: "Document is still processing" }, status: 409 });
      const memory = yield* MemoryProvider.Service;
      const failure = yield* memory
        .deleteSessionConversation({
          sessionId: SessionId.make("session-1"),
          userId: UserId.make("user-1"),
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderRejected",
        operation: "deleteSessionConversation",
        status: 409,
      });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("deletes every Knowledge Base item in one User container", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({ body: { success: true }, status: 200 });
      const memory = yield* MemoryProvider.Service;
      const result = yield* memory.deleteUserKnowledge({
        userId: UserId.make("user:with/provider-invalid characters"),
      });

      expect(result).toEqual({ _tag: "Deleted" });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: undefined,
          method: "DELETE",
          path: "/v3/container-tags/u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("normalizes only deletion-specific absence responses", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        { body: { error: "Already forgotten" }, status: 409 },
        { body: { error: "Document not found" }, status: 404 },
        { body: { error: "Container not found" }, status: 404 },
      );
      const memory = yield* MemoryProvider.Service;
      const forgotten = yield* memory.forgetKnowledge({
        memoryIds: [MemoryProvider.KnowledgeMemoryId.make("memory-1")],
        userId: UserId.make("user-1"),
      });
      const session = yield* memory.deleteSessionConversation({
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      });
      const user = yield* memory.deleteUserKnowledge({ userId: UserId.make("user-1") });

      expect(forgotten).toEqual({ _tag: "AlreadyAbsent" });
      expect(session).toEqual({ _tag: "AlreadyAbsent" });
      expect(user).toEqual({ _tag: "AlreadyAbsent" });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("keeps authorization and transient provider failures distinct", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        { body: { error: "Insufficient role" }, status: 403 },
        { body: { error: "Rate limited" }, status: 429 },
      );
      const memory = yield* MemoryProvider.Service;
      const rejected = yield* memory
        .deleteUserKnowledge({ userId: UserId.make("user-1") })
        .pipe(Effect.flip);
      const unavailable = yield* memory
        .recall({ query: "deployment", userId: UserId.make("user-1") })
        .pipe(Effect.flip);

      expect(rejected).toMatchObject({
        _tag: "MemoryProviderRejected",
        operation: "deleteUserKnowledge",
        status: 403,
      });
      expect(unavailable).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        operation: "recall",
        status: 429,
      });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("rejects malformed provider payloads at the adapter boundary", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({ body: { profile: "not-a-profile" }, status: 200 });
      const memory = yield* MemoryProvider.Service;
      const failure = yield* memory
        .recall({ query: "deployment", userId: UserId.make("user-1") })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        diagnostic: "responseDecoding",
        message: "The MemoryProvider returned an invalid response",
        operation: "recall",
      });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("rejects a conversation response for a different provider identity", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: { conversationId: "another-session", id: "document-1", status: "queued" },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const failure = yield* memory
        .saveConversation({
          conversation: MemoryProvider.ConversationSnapshot.make({
            messages: [
              { content: "Hello", role: "user" },
              { content: "Hi", role: "assistant" },
            ],
            usageStartIndex: 0,
          }),
          sessionId: SessionId.make("session-1"),
          userId: UserId.make("user-1"),
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        diagnostic: "identityMismatch",
        message: "The MemoryProvider returned an invalid response",
        operation: "saveConversation",
      });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("keeps Native Memory when provider recall returns a malformed response", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({ body: { profile: "not-a-profile" }, status: 200 });
      const result = yield* PromptAssembly.assemble({
        agentInstructions: "Native Memory remains available",
        query: "deployment",
        userId: UserId.make("user-1"),
      });

      expect(result._tag).toBe("ProviderRecallUnavailable");
      expect(result.instructions).toContain("Native Memory remains available");
      expect(result.instructions).not.toContain("not-a-profile");
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly method: string | undefined;
  readonly path: string;
}

const providerLayer = (apiBaseURL: string) =>
  SupermemoryMemoryProvider.layer({
    apiBaseURL,
    apiKey: Redacted.make("test-api-key"),
    rateCard: {
      ingestionTokenUsdMicros: 5n,
      retrievalUsdMicros: 5n,
      version: "supermemory-public-2026-08-22",
    },
  });

interface ProviderResponse {
  readonly body?: unknown;
  readonly status: number;
}

const withProvider = <A, E, R>(
  run: (fixture: {
    readonly origin: string;
    readonly requests: Array<RecordedRequest>;
    readonly respondWith: (...responses: ReadonlyArray<ProviderResponse>) => void;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.callback<{
        readonly origin: string;
        readonly requests: Array<RecordedRequest>;
        readonly respondWith: (...responses: ReadonlyArray<ProviderResponse>) => void;
        readonly server: ReturnType<typeof createServer>;
      }>((resume) => {
        const requests: Array<RecordedRequest> = [];
        const responses: Array<ProviderResponse> = [];
        const server = createServer((request, response) => {
          void respond(request, response, requests, responses);
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            resume(Effect.die(new Error("Provider emulator did not bind a TCP port")));
            return;
          }
          resume(
            Effect.succeed({
              origin: `http://127.0.0.1:${address.port}`,
              requests,
              respondWith: (...nextResponses) => {
                responses.push(...nextResponses);
              },
              server,
            }),
          );
        });
      }),
      ({ server }) =>
        Effect.callback<void>((resume) => {
          server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
        }),
    ).pipe(Effect.flatMap(run)),
  );

const respond = async (
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<RecordedRequest>,
  responses: Array<ProviderResponse>,
) => {
  const body = await readJson(request);
  requests.push({
    authorization: request.headers.authorization,
    body,
    method: request.method,
    path: request.url ?? "",
  });
  const next = responses.shift() ?? { body: { error: "Missing scripted response" }, status: 500 };
  response.writeHead(next.status, { "content-type": "application/json" });
  response.end(next.body === undefined ? undefined : JSON.stringify(next.body));
};

const readJson = async (request: IncomingMessage): Promise<Schema.Json | undefined> => {
  const chunks: Array<Uint8Array> = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.length === 0
    ? undefined
    : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(body);
};
