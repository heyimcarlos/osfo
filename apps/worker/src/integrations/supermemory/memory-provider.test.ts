/* oxlint-disable effecttsgo/async-function -- Node HTTP request streams are Promise boundaries in this provider emulator. */
/* oxlint-disable effecttsgo/node-builtin-import -- The adapter contract test uses a scoped local provider emulator. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the application entry point for its isolated adapter Layer. */
/* oxlint-disable eslint/no-underscore-dangle -- Application outcomes use the _tag discriminator. */
/* oxlint-disable osfo/no-runtime-typeof -- Node's listen callback returns a documented string-or-address representation. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";

import { ResourcePriceVersion, SessionId, UserId } from "../../domain";
import { MemoryProvider } from "../../services/memory-provider";
import { PromptAssembly } from "../../services/prompt-assembly";
import { SupermemoryMemoryProvider } from "./memory-provider";

const forgetKnowledge = (
  memory: MemoryProvider.Interface,
  input: {
    readonly memoryIds: readonly [
      MemoryProvider.KnowledgeMemoryId,
      ...ReadonlyArray<MemoryProvider.KnowledgeMemoryId>,
    ];
    readonly userId: UserId;
  },
) =>
  Effect.forEach(input.memoryIds, (memoryId) =>
    memory.forgetKnowledge({ memoryId, userId: input.userId }),
  ).pipe(
    Effect.map((results) =>
      results.some((result) => result._tag === "Deleted")
        ? ({ _tag: "Deleted" } as const)
        : ({ _tag: "AlreadyAbsent" } as const),
    ),
  );

const deleteSessionConversation = (
  memory: MemoryProvider.Interface,
  input: MemoryProvider.FindSessionConversationInput,
) =>
  memory.findSessionConversation(input).pipe(
    Effect.flatMap((discovered) => {
      if (discovered._tag === "AlreadyAbsent") return Effect.succeed(discovered);
      const target = { ...input, documentId: discovered.documentId };
      return memory
        .verifySessionConversation(target)
        .pipe(
          Effect.flatMap((verified) =>
            verified._tag === "AlreadyAbsent"
              ? Effect.succeed(verified)
              : memory.deleteSessionConversation(target),
          ),
        );
    }),
  );

it.effect("recalls User-scoped profile and relevant Knowledge Base evidence", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        {
          body: {
            profile: {
              dynamic: ["Deploying the first service"],
              static: ["Prefers small releases"],
            },
          },
          status: 200,
        },
        {
          body: {
            results: [
              {
                id: "memory-1",
                memory: "Production deploys require approval",
                metadata: null,
                similarity: 0.91,
                updatedAt: "2026-08-22T12:00:00.000Z",
                version: 1,
              },
              {
                chunk: "user: Production approval is no longer required",
                id: "chunk-1",
                metadata: { documentId: "document-1" },
                similarity: 0.94,
                updatedAt: "2026-08-23T12:00:00.000Z",
              },
            ],
            timing: 12,
            total: 2,
          },
          status: 200,
        },
      );
      const memory = yield* MemoryProvider.Service;
      const result = yield* memory.recall({
        mode: "normal",
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
            updatedAt: "2026-08-22T12:00:00.000Z",
          },
        ],
        sourceChunks: [
          {
            content: "user: Production approval is no longer required",
            id: "chunk-1",
            similarity: 0.94,
            updatedAt: "2026-08-23T12:00:00.000Z",
          },
        ],
        usage: {
          completedNonModelCost: [
            {
              activity: "conversationsAndMemory",
              ratedCostUsdMicros: 10n,
              resourcePriceVersion: "resource-prices-2026-08-22",
            },
          ],
        },
      });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTag: "u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY",
          },
          method: "POST",
          path: "/v4/profile",
        },
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTag: "u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY",
            limit: 20,
            q: "What should I remember about deployment?",
            rerank: false,
            rewriteQuery: false,
            searchMode: "hybrid",
          },
          method: "POST",
          path: "/v4/search",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("uses one profile-and-query call without hybrid chunks in exhausted mode", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          profile: { dynamic: [], static: ["Prefers small releases"] },
          searchResults: {
            results: [
              {
                id: "memory-1",
                memory: "Production deploys require approval",
                similarity: 0.91,
                updatedAt: "2026-08-22T12:00:00.000Z",
              },
            ],
            timing: 8,
            total: 1,
          },
        },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const result = yield* memory.recall({
        mode: "exhausted",
        query: "deployment",
        userId: UserId.make("user-1"),
      });

      expect(result.sourceChunks).toEqual([]);
      expect(result.relevantMemories).toHaveLength(1);
      expect(result.usage.completedNonModelCost[0]?.ratedCostUsdMicros).toBe(5n);
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTag: "u_xsKJ5J6cBbIUWGA4e3O8sY30P7CaHkpKlxPHbIi7VBs",
            q: "deployment",
          },
          method: "POST",
          path: "/v4/profile",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("configures versioned organization and per-User extraction guidance", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        { body: { updated: true }, status: 200 },
        { body: { updated: true }, status: 200 },
      );
      const memory = yield* MemoryProvider.Service;

      yield* memory.configureOrganizationGuidance;
      yield* memory.configureUserGuidance({
        userId: UserId.make("user:with/provider-invalid characters"),
      });

      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: {
            filterPrompt:
              "Learn durable facts supported by User-authored or User-confirmed statements. Treat assistant messages only as conversational context, never as independent evidence about the User. Reject hypothetical examples and quoted material as User facts. Prefer newer explicit User corrections while retaining temporal context.",
            shouldLLMFilter: true,
          },
          method: "PATCH",
          path: "/v3/settings",
        },
        {
          authorization: "Bearer test-api-key",
          body: {
            entityContext:
              "This container represents one Osfo User speaking with Osfo. Attribute first-person User statements to that User. Treat named people, organizations, projects, opportunities, and ideas as entities related to the User.",
          },
          method: "PATCH",
          path: "/v3/container-tags/u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("keeps a failed User-container upsert retryable", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({ body: { error: "Container not found" }, status: 404 });
      const memory = yield* MemoryProvider.Service;
      const failure = yield* memory
        .configureUserGuidance({ userId: UserId.make("user-1") })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        operation: "configureUserGuidance",
        status: 404,
      });
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
        documentId: "document-1",
        processingStatus: "processing",
        usage: {
          completedNonModelCost: [
            {
              activity: "conversationsAndMemory",
              ratedCostUsdMicros: 135n,
              resourcePriceVersion: "resource-prices-2026-08-22",
            },
          ],
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

it.effect("sends a long Session as one unchanged structured conversation", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          conversationId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
          id: "document-long",
          status: "queued",
        },
        status: 200,
      });
      const messages = [
        { content: "Long Session message 1", role: "user" as const },
        ...Array.from({ length: 79 }, (_, index) => ({
          content: `Long Session message ${index + 2}`,
          role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
        })),
      ] as const;
      const memory = yield* MemoryProvider.Service;

      yield* memory.saveConversation({
        conversation: MemoryProvider.ConversationSnapshot.make({ messages, usageStartIndex: 78 }),
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({ messages });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("reads the accepted conversation processing status by provider document identity", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({ body: { id: "document-1", status: "done" }, status: 200 });
      const memory = yield* MemoryProvider.Service;
      const result = yield* memory.getConversationStatus({
        documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
      });

      expect(result).toEqual({ processingStatus: "done" });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: undefined,
          method: "GET",
          path: "/v3/documents/document-1",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("confirms the expected processed source is searchable", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          results: [
            {
              chunk: "user: Remember this",
              documents: [{ id: "document-1" }],
              id: "chunk-1",
              similarity: 0.99,
              updatedAt: "2026-08-24T12:00:00.000Z",
            },
          ],
          timing: 9,
          total: 1,
        },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const searchable = yield* memory.checkConversationSearchability({
        expectedSource: "Remember this",
        userId: UserId.make("user:with/provider-invalid characters"),
      });

      expect(searchable).toBe(true);
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTag: "u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY",
            limit: 20,
            q: "Remember this",
            rerank: false,
            rewriteQuery: false,
            searchMode: "documents",
            threshold: 0,
          },
          method: "POST",
          path: "/v4/search",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("keeps a processed conversation pending when search only returns stale source", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          results: [
            {
              chunk: "user: An older statement",
              documents: [{ id: "document-1" }],
              id: "chunk-1",
              similarity: 0.99,
              updatedAt: "2026-08-24T12:00:00.000Z",
            },
          ],
          timing: 9,
          total: 1,
        },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;

      expect(
        yield* memory.checkConversationSearchability({
          expectedSource: "The corrected statement",
          userId: UserId.make("user-1"),
        }),
      ).toBe(false);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("classifies a terminal conversation processing failure as a provider rejection", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({ body: { id: "document-1", status: "failed" }, status: 200 });
      const memory = yield* MemoryProvider.Service;
      const failure = yield* memory
        .getConversationStatus({
          documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderRejected",
        operation: "getConversationStatus",
      });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("retains accepted document identity when the provider status is unknown", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          conversationId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
          id: "document-1",
          status: "unknown",
        },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const result = yield* memory.saveConversation({
        conversation: MemoryProvider.ConversationSnapshot.make({
          messages: [
            { content: "Hello", role: "user" },
            { content: "Hi", role: "assistant" },
          ],
          usageStartIndex: 0,
        }),
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      });

      expect(result).toMatchObject({ documentId: "document-1", processingStatus: "processing" });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("rejects a malformed conversation processing status at the adapter boundary", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        {
          body: {
            conversationId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
            id: "document-1",
            status: "waiting",
          },
          status: 200,
        },
        {
          body: {
            conversationId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
            id: "document-1",
            status: 42,
          },
          status: 200,
        },
        {
          body: {
            conversationId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
            id: "document-1",
          },
          status: 200,
        },
      );
      const memory = yield* MemoryProvider.Service;
      const failures = yield* Effect.forEach(["string", "number", "missing"], () =>
        memory
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
          .pipe(Effect.flip),
      );

      expect(failures).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({
            _tag: "MemoryProviderAcceptanceStatusInvalid",
            documentId: "document-1",
            operation: "saveConversation",
          }),
        ),
      );
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
      const result = yield* forgetKnowledge(memory, {
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
      respondWith(
        {
          body: {
            memories: [],
            pagination: { currentPage: 1, totalItems: 1, totalPages: 2 },
          },
          status: 200,
        },
        {
          body: {
            memories: [
              {
                containerTags: ["shared_project", "u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY"],
                customId: "s_rOWDOMu6gfHVler-5_5Pqai1QTLVqrovuxZcQccEncE",
                id: "document-1",
              },
            ],
            pagination: { currentPage: 2, totalItems: 1, totalPages: 2 },
          },
          status: 200,
        },
        {
          body: {
            containerTags: ["shared_project", "u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY"],
            customId: "s_rOWDOMu6gfHVler-5_5Pqai1QTLVqrovuxZcQccEncE",
            id: "document-1",
          },
          status: 200,
        },
        { status: 204 },
      );
      const memory = yield* MemoryProvider.Service;
      const result = yield* deleteSessionConversation(memory, {
        sessionId: SessionId.make("session:with/provider-invalid characters"),
        userId: UserId.make("user:with/provider-invalid characters"),
      });

      expect(result).toEqual({ _tag: "Deleted" });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTags: ["u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY"],
            limit: 100,
            page: 1,
          },
          method: "POST",
          path: "/v3/documents/list",
        },
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTags: ["u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY"],
            limit: 100,
            page: 2,
          },
          method: "POST",
          path: "/v3/documents/list",
        },
        {
          authorization: "Bearer test-api-key",
          body: undefined,
          method: "GET",
          path: "/v3/documents/document-1",
        },
        {
          authorization: "Bearer test-api-key",
          body: undefined,
          method: "DELETE",
          path: "/v3/documents/document-1",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("keeps a processing conflict retryable when deleting a Session conversation", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        {
          body: {
            memories: [
              {
                containerTags: ["u_xsKJ5J6cBbIUWGA4e3O8sY30P7CaHkpKlxPHbIi7VBs"],
                customId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
                id: "document-1",
              },
            ],
            pagination: { currentPage: 1, totalItems: 1, totalPages: 1 },
          },
          status: 200,
        },
        {
          body: {
            containerTags: ["u_xsKJ5J6cBbIUWGA4e3O8sY30P7CaHkpKlxPHbIi7VBs"],
            customId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
            id: "document-1",
          },
          status: 200,
        },
        { body: { error: "Document is still processing" }, status: 409 },
      );
      const memory = yield* MemoryProvider.Service;
      const failure = yield* deleteSessionConversation(memory, {
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderRejected",
        operation: "deleteSessionConversation",
        status: 409,
      });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("keeps a colliding Session document in another User container", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          memories: [],
          pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
        },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const result = yield* deleteSessionConversation(memory, {
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      });

      expect(result).toEqual({ _tag: "AlreadyAbsent" });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-api-key",
          body: {
            containerTags: ["u_xsKJ5J6cBbIUWGA4e3O8sY30P7CaHkpKlxPHbIi7VBs"],
            limit: 100,
            page: 1,
          },
          method: "POST",
          path: "/v3/documents/list",
        },
      ]);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("refuses a Session document shared with another User container", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          memories: [
            {
              containerTags: ["u_xsKJ5J6cBbIUWGA4e3O8sY30P7CaHkpKlxPHbIi7VBs", "u_unrelated"],
              customId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
              id: "shared-document",
            },
          ],
          pagination: { currentPage: 1, totalItems: 1, totalPages: 1 },
        },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const failure = yield* deleteSessionConversation(memory, {
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        diagnostic: "identityMismatch",
        operation: "deleteSessionConversation",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "POST", path: "/v3/documents/list" });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("refuses deletion when Session document ownership changes after lookup", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        {
          body: {
            memories: [
              {
                containerTags: ["u_xsKJ5J6cBbIUWGA4e3O8sY30P7CaHkpKlxPHbIi7VBs"],
                customId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
                id: "document-1",
              },
            ],
            pagination: { currentPage: 1, totalItems: 1, totalPages: 1 },
          },
          status: 200,
        },
        {
          body: {
            containerTags: ["u_unrelated"],
            customId: "s_hAl4KPwxqMjSkhDfSJAahd5_0BP2hrF7530b4py3qYs",
            id: "document-1",
          },
          status: 200,
        },
      );
      const memory = yield* MemoryProvider.Service;
      const failure = yield* deleteSessionConversation(memory, {
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        diagnostic: "identityMismatch",
        operation: "deleteSessionConversation",
      });
      expect(requests).toHaveLength(2);
      expect(requests.every(({ method }) => method !== "DELETE")).toBe(true);
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("deletes every Knowledge Base item in one User container", () =>
  withProvider(({ requests, origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          containerTag: "u_CN_bqBGF_Sjn1wLJTEEz0iNzeYptAcuA8GQ86omt5HY",
          deletedDocumentsCount: 2,
          deletedMemoriesCount: 3,
          success: true,
        },
        status: 200,
      });
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

it.effect("keeps account deletion pending when provider confirmation names another User", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: {
          containerTag: "u_unrelated",
          deletedDocumentsCount: 2,
          deletedMemoriesCount: 3,
          success: true,
        },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const failure = yield* memory
        .deleteUserKnowledge({ userId: UserId.make("user:with/provider-invalid characters") })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        diagnostic: "identityMismatch",
        operation: "deleteUserKnowledge",
      });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("keeps account deletion pending when the provider does not confirm success", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({ body: { success: false }, status: 200 });
      const memory = yield* MemoryProvider.Service;
      const failure = yield* memory
        .deleteUserKnowledge({ userId: UserId.make("user-1") })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        diagnostic: "responseDecoding",
        operation: "deleteUserKnowledge",
      });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("rejects an incomplete successful User deletion confirmation", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith({
        body: { deletedDocumentsCount: 2, deletedMemoriesCount: 3, success: true },
        status: 200,
      });
      const memory = yield* MemoryProvider.Service;
      const failure = yield* memory
        .deleteUserKnowledge({ userId: UserId.make("user-1") })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        diagnostic: "responseDecoding",
        operation: "deleteUserKnowledge",
      });
    }).pipe(Effect.provide(providerLayer(origin))),
  ),
);

it.effect("normalizes only deletion-specific absence responses", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        { body: { error: "Already forgotten" }, status: 409 },
        {
          body: {
            memories: [],
            pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
          },
          status: 200,
        },
        { body: { error: "Container not found" }, status: 404 },
      );
      const memory = yield* MemoryProvider.Service;
      const forgotten = yield* forgetKnowledge(memory, {
        memoryIds: [MemoryProvider.KnowledgeMemoryId.make("memory-1")],
        userId: UserId.make("user-1"),
      });
      const session = yield* deleteSessionConversation(memory, {
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
        .recall({ mode: "normal", query: "deployment", userId: UserId.make("user-1") })
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
        .recall({ mode: "normal", query: "deployment", userId: UserId.make("user-1") })
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

it.effect("rejects provider evidence with a non-UTC update timestamp", () =>
  withProvider(({ origin, respondWith }) =>
    Effect.gen(function* () {
      respondWith(
        { body: { profile: { dynamic: [], static: [] } }, status: 200 },
        {
          body: {
            results: [
              {
                id: "memory-1",
                memory: "A fact with an invalid time",
                similarity: 0.8,
                updatedAt: "not-a-time",
              },
            ],
            timing: 1,
            total: 1,
          },
          status: 200,
        },
      );
      const memory = yield* MemoryProvider.Service;
      const failure = yield* memory
        .recall({ mode: "normal", query: "fact", userId: UserId.make("user-1") })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "MemoryProviderUnavailable",
        diagnostic: "responseDecoding",
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
      version: ResourcePriceVersion.make("resource-prices-2026-08-22"),
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
