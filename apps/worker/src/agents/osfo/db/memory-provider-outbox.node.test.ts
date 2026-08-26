/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/node-builtin-import -- This Node-only suite supplies real SQLite persistence to the Durable SQLite adapter. */
/* oxlint-disable osfo/no-runtime-typeof -- The adapter branches over node:sqlite's closed SQLOutputValue union. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- The test adapter proves Cloudflare's generic cursor result shapes at its boundary. */
/* oxlint-disable osfo/no-chained-type-assertions -- Node-only compatibility stubs prove the narrow runtime members they supply. */
/* oxlint-disable typescript/no-unnecessary-type-parameters -- SqlStorageCursor.raw requires its upstream generic method signature. */
/* oxlint-disable eslint/no-underscore-dangle -- Effect payload assertions use the canonical _tag discriminator. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layers. */
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { Session, type SqlProvider } from "agents/experimental/memory/session";

import { expect, it } from "@effect/vitest";
import { BrowserCrypto } from "@effect/platform-browser";
import { Deferred, Effect, Fiber, Option, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import { Db, DbTimestamp } from "../../../db";
import {
  AgentId,
  AgentInitializationId,
  AllowancePeriodId,
  AssistantMessageId,
  ConversationRouteId,
  ResourcePriceVersion,
  SessionId,
  ThinkRequestId,
  UserId,
} from "../../../domain";
import { ActionId } from "../../../domain/action-execution";
import { AuthSessionId } from "../../../domain/auth-session";
import { ApprovalPresentation } from "../../../services/authorization";
import { makeAgentDb } from "./client";
import { agentMigrations, applyAgentMigrations, applyMigrationChain } from "./migrate";
import {
  makeMemoryProviderOutboxStore,
  MemoryProviderDeletionProgress,
  MemoryProviderOutboxId,
} from "./memory-provider-outbox";
import { makeAgentStore } from "./store";
import { ConversationSnapshotProjection } from "../memory-provider-projection";
import { MemoryProvider } from "../../../services/memory-provider";
import { reconcileMemoryProviderOutbox } from "../memory-provider-reconciliation";
import { makeProviderConversationSaveGate } from "../provider-conversation-save-gate";
import { deleteLocalSession } from "../session-deletion";

/**
 * These tests need white-box access because atomic SQLite rollback, unique claims, and stale lease
 * settlement cannot be observed through the public Worker without a forbidden test-only DO route.
 */

const now = DbTimestamp.make("2026-08-23T12:00:00.000Z");
const past = DbTimestamp.make("1960-01-01T00:00:00.000Z");
const liveLease = DbTimestamp.make("2026-08-23T12:01:00.000Z");
const extendedLease = DbTimestamp.make("2026-08-23T12:02:00.000Z");

it("includes every generated Agent migration in the runtime manifest", () => {
  const migrations = new URL("./migrations/", import.meta.url);
  const migrationFiles = readdirSync(migrations).filter((name) => name.endsWith(".sql"));
  // oxlint-disable-next-line unicorn/no-array-sort -- Generated filenames define migration order.
  migrationFiles.sort();
  const manifest = readFileSync(new URL("./migrate.ts", import.meta.url), "utf8");
  const imports = [
    ...manifest.matchAll(/import (\w+) from "\.\/migrations\/(\d{4}_[^"]+\.sql)";/gu),
  ];
  const referencedSql = new Set([...manifest.matchAll(/\bsql: (\w+),/gu)].map((match) => match[1]));

  expect(imports.map((match) => match[2])).toEqual(migrationFiles);
  expect(imports.every((match) => referencedSql.has(match[1] ?? ""))).toBe(true);
});

it.effect("activates an Agent that slept before the conversation processing migration", () =>
  withEmptyDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const previousMigrations = agentMigrations.filter(({ version }) => version <= 8);
      yield* applyMigrationChain(asDurableObjectStorage(storage), previousMigrations);
      database
        .prepare(
          `INSERT INTO osfo_memory_provider_outbox
            (allowance_period_id, attempt_count, available_at, enqueued_at, operation_type,
             ordering_key, outbox_id, payload_json, sequence, status)
            VALUES (NULL, 0, ?, ?, 'deleteSessionConversation', 'user:user-1',
              'delete-session-1', ?, 1, 'pending')`,
        )
        .run(
          now,
          now,
          '{"_tag":"DeleteSessionConversation","sessionId":"session-1","userId":"user-1"}',
        );
      database
        .prepare(
          `INSERT INTO osfo_memory_provider_outbox
            (allowance_period_id, attempt_count, available_at, enqueued_at, operation_type,
             ordering_key, outbox_id, payload_json, provider_applied_at, sequence, status,
             usage_json)
            VALUES ('allowance-1', 1, ?, ?, 'saveConversation', 'user:user-2',
              'legacy-accepted-conversation', ?, ?, 2, 'pending', ?)`,
        )
        .run(
          now,
          now,
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This seeds a retained legacy row before the version-10 configuration migration.
          JSON.stringify({
            _tag: "SaveConversation",
            projection: conversationProjection("assistant-legacy"),
          }),
          now,
          '{"items":[],"rateCardVersion":"legacy-rate-card"}',
        );

      const result = yield* applyAgentMigrations(asDurableObjectStorage(storage));

      expect(result).toEqual({ appliedVersions: [9, 10, 11, 12], currentVersion: 12 });
      expect(
        database
          .prepare(
            `SELECT last_error, outbox_id, provider_document_id,
                provider_status, provider_submission_ambiguous, status
              FROM osfo_memory_provider_outbox
              ORDER BY sequence`,
          )
          .all(),
      ).toEqual([
        {
          last_error: null,
          outbox_id: "delete-session-1",
          provider_document_id: null,
          provider_status: null,
          provider_submission_ambiguous: 0,
          status: "pending",
        },
        {
          last_error: "Provider acceptance predates durable processing status",
          outbox_id: "legacy-accepted-conversation",
          provider_document_id: null,
          provider_status: null,
          provider_submission_ambiguous: 0,
          status: "failed",
        },
      ]);
      const legacyClaim = yield* makeMemoryProviderOutboxStore(
        makeAgentDb(asDurableObjectStorage(storage)),
      )
        .claimNext(now, liveLease, "legacy-authless-claim")
        .pipe(Effect.result);
      expect(Result.isFailure(legacyClaim)).toBe(true);
    }),
  ),
);

it.effect("atomically records a committed turn and its provider conversation snapshot", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      const store = makeAgentStore(makeAgentDb(asDurableObjectStorage(storage)));
      const reference = committedTurn("assistant-1", "request-1");
      const projection = conversationProjection("assistant-1");

      yield* store.recordCommittedTurn(reference, projection);

      expect(countRows(database, "osfo_committed_turns")).toBe(1);
      expect(countRows(database, "osfo_memory_provider_outbox")).toBe(1);
      const persisted = database
        .prepare(
          "SELECT outbox_id, payload_json FROM osfo_memory_provider_outbox ORDER BY sequence",
        )
        .get();
      expect(persisted).toEqual({
        outbox_id: "conversation:9:session-1:assistant-1",
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This asserts the exact stored encoding of an already typed payload.
        payload_json: JSON.stringify({ _tag: "SaveConversation", projection }),
      });
    }),
  ),
);

it.effect("keeps an unaccepted leased provider save visible across Agent activation", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const agentStore = makeAgentStore(db);
      const outbox = makeMemoryProviderOutboxStore(db);
      yield* agentStore.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );

      const claimed = yield* outbox.claimNext(now, liveLease, "ambiguous-provider-save");

      expect(Option.isSome(claimed)).toBe(true);
      yield* outbox.retainAmbiguousProviderSubmission(
        Option.getOrThrow(claimed),
        "The provider response was lost",
      );
      const reactivated = makeMemoryProviderOutboxStore(
        makeAgentDb(asDurableObjectStorage(storage)),
      );
      expect(yield* reactivated.hasUnsettledProviderConversationWork).toBe(true);
      expect(
        database
          .prepare(
            "SELECT last_error, status FROM osfo_memory_provider_outbox WHERE operation_type = 'saveConversation'",
          )
          .get(),
      ).toEqual({ last_error: "The provider response was lost", status: "claimed" });
      expect(yield* reactivated.claimNext(now, extendedLease, "duplicate-save")).toEqual(
        Option.none(),
      );
      const reclaimed = yield* reactivated.claimNext(
        liveLease,
        extendedLease,
        "expired-save-retry",
      );
      expect(Option.isSome(reclaimed)).toBe(true);
      expect(yield* reactivated.hasUnsettledProviderConversationWork).toBe(true);
    }),
  ),
);

it.effect("retains versioned provider configuration status across retries and migration", () =>
  withDatabase(({ storage }) =>
    Effect.gen(function* () {
      const store = makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage)));

      const required = yield* store.requireConfiguration(
        "organization",
        MemoryProvider.organizationGuidanceVersion,
        now,
      );
      expect(required).toBe(false);
      expect(yield* store.inspectConfiguration("organization")).toEqual(
        Option.some({
          configuredAt: null,
          scope: "organization",
          status: "pending",
          version: "osfo-filter-prompt-v1",
        }),
      );

      expect(
        yield* store.completeConfiguration(
          "organization",
          MemoryProvider.organizationGuidanceVersion,
          liveLease,
        ),
      ).toBe(true);
      expect(
        yield* store.requireConfiguration(
          "organization",
          MemoryProvider.organizationGuidanceVersion,
          extendedLease,
        ),
      ).toBe(true);

      const nextVersion = MemoryProvider.ConfigurationVersion.make("osfo-filter-prompt-v2");
      expect(yield* store.requireConfiguration("organization", nextVersion, extendedLease)).toBe(
        false,
      );
      expect(yield* store.inspectConfiguration("organization")).toEqual(
        Option.some({
          configuredAt: null,
          scope: "organization",
          status: "pending",
          version: "osfo-filter-prompt-v2",
        }),
      );
    }),
  ),
);

it.effect("retains a deduplicated recent-turn bridge until indexed evidence is searchable", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const agentStore = makeAgentStore(db);
      const outbox = makeMemoryProviderOutboxStore(db);
      const first = conversationProjection("assistant-1");
      const second = ConversationSnapshotProjection.make({
        ...conversationProjection("assistant-2"),
        conversation: MemoryProvider.ConversationSnapshot.make({
          messages: [
            { content: "Remember this", role: "user" },
            { content: "I will remember it", role: "assistant" },
            { content: "Actually, approval is no longer required", role: "user" },
            { content: "Understood", role: "assistant" },
          ],
          usageStartIndex: 1,
        }),
      });
      yield* agentStore.recordCommittedTurn(committedTurn("assistant-1", "request-1"), first);
      yield* agentStore.recordCommittedTurn(committedTurn("assistant-2", "request-2"), second);

      const bridge = yield* outbox.readRecentTurnBridge(UserId.make("user-1"));
      expect(bridge.flatMap(({ messages }) => messages)).toEqual([
        { content: "Remember this", role: "user" },
        { content: "I will remember it", role: "assistant" },
        { content: "Actually, approval is no longer required", role: "user" },
        { content: "Understood", role: "assistant" },
      ]);
      expect(bridge.map(({ sourceId }) => sourceId)).toEqual([
        "conversation:9:session-1:assistant-1",
        "conversation:9:session-1:assistant-2",
      ]);

      database.prepare("UPDATE osfo_memory_provider_outbox SET provider_status = 'done'").run();
      expect(
        (yield* outbox.readRecentTurnBridge(UserId.make("user-1"))).map(({ sourceId }) => sourceId),
      ).toEqual(["conversation:9:session-1:assistant-1", "conversation:9:session-1:assistant-2"]);
      database.prepare("UPDATE osfo_memory_provider_outbox SET status = 'completed'").run();
      expect(yield* outbox.readRecentTurnBridge(UserId.make("user-1"))).toEqual([]);
    }),
  ),
);

it.effect("keeps the first durable snapshot when reconciliation sees later history changes", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      const store = makeAgentStore(makeAgentDb(asDurableObjectStorage(storage)));
      const reference = committedTurn("assistant-1", "request-1");
      const original = conversationProjection("assistant-1");
      yield* store.recordCommittedTurn(reference, original);

      const reconciled = ConversationSnapshotProjection.make({
        ...original,
        conversation: MemoryProvider.ConversationSnapshot.make({
          messages: [
            { content: "Remember this", role: "user" },
            { content: "I will remember it\nTool result: settled later", role: "assistant" },
          ],
          usageStartIndex: 0,
        }),
      });

      yield* store.recordCommittedTurn({ ...reference, source: "reconciliation" }, reconciled);

      expect(countRows(database, "osfo_committed_turns")).toBe(1);
      expect(countRows(database, "osfo_memory_provider_outbox")).toBe(1);
      expect(
        database
          .prepare("SELECT payload_json FROM osfo_memory_provider_outbox WHERE outbox_id = ?")
          .get("conversation:9:session-1:assistant-1"),
      ).toEqual({
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This proves reconciliation preserves the exact first durable provider payload.
        payload_json: JSON.stringify({ _tag: "SaveConversation", projection: original }),
      });
    }),
  ),
);

it.effect("rolls back the committed receipt when durable enqueue fails", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      database.exec(`CREATE TRIGGER reject_memory_provider_enqueue
        BEFORE INSERT ON osfo_memory_provider_outbox
        BEGIN
          SELECT RAISE(ABORT, 'injected enqueue failure');
        END`);
      const store = makeAgentStore(makeAgentDb(asDurableObjectStorage(storage)));

      const outcome = yield* store
        .recordCommittedTurn(
          committedTurn("assistant-1", "request-1"),
          conversationProjection("assistant-1"),
        )
        .pipe(Effect.result);

      expect(Result.isFailure(outcome)).toBe(true);
      expect(countRows(database, "osfo_committed_turns")).toBe(0);
      expect(countRows(database, "osfo_memory_provider_outbox")).toBe(0);
    }),
  ),
);

it.effect("serializes successive claims and recovers an expired lease with exact identity", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const outbox = makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage)));
      yield* outbox.enqueueDeletion(deletion("delete-session-1", "session-1"));
      yield* outbox.enqueueDeletion(deletion("delete-session-1", "session-1"));
      expect(countRows(database, "osfo_memory_provider_outbox")).toBe(1);
      const conflictingIdentity = yield* outbox
        .enqueueDeletion(deletion("delete-session-1", "another-session"))
        .pipe(Effect.result);
      expect(Result.isFailure(conflictingIdentity)).toBe(true);
      yield* outbox.enqueueDeletion(deletion("delete-session-2", "session-2", "user-2"));

      const [first, second] = yield* Effect.all(
        [outbox.claimNext(now, liveLease, "claim-a"), outbox.claimNext(now, liveLease, "claim-b")],
        { concurrency: "unbounded" },
      );

      expect(Option.getOrThrow(first).outboxId).toBe("delete-session-1");
      expect(Option.getOrThrow(second).outboxId).toBe("delete-session-2");

      const recovered = yield* outbox.claimNext(liveLease, extendedLease, "claim-c");
      expect(Option.getOrThrow(recovered)).toMatchObject({
        attemptCount: 2,
        outboxId: "delete-session-1",
        payload: {
          _tag: "DeleteSessionConversation",
          sessionId: "session-1",
          userId: "user-1",
        },
      });
      expect(yield* outbox.complete(Option.getOrThrow(first), liveLease)).toBe(false);
      expect(yield* outbox.complete(Option.getOrThrow(recovered), liveLease)).toBe(true);
    }),
  ),
);

it.effect("treats deletion progress as part of exact enqueue identity", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const outbox = makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage)));
      const input = {
        ...deletion("delete-progress-identity", "session-1"),
        deletionProgress: sessionDeletionProgress("document-1"),
      };

      yield* outbox.enqueueDeletion(input);
      yield* outbox.enqueueDeletion(input);
      const conflicting = yield* outbox
        .enqueueDeletion({
          ...input,
          deletionProgress: sessionDeletionProgress("document-2"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(conflicting)).toBe(true);
      expect(countRows(database, "osfo_memory_provider_outbox")).toBe(1);
      expect(
        database
          .prepare(
            "SELECT deletion_progress_json FROM osfo_memory_provider_outbox WHERE outbox_id = ?",
          )
          .get(input.outboxId),
      ).toEqual({
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This proves the exact normalized persisted boundary.
        deletion_progress_json: JSON.stringify(input.deletionProgress),
      });
    }),
  ),
);

it.effect("treats deletion progress as part of exact retained-preparation identity", () =>
  withDatabase(({ storage }) =>
    Effect.gen(function* () {
      const outbox = makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage)));
      const input = {
        ...deletion("delete-preparation-progress", "session-1"),
        claimExpiresAt: liveLease,
        claimToken: "correction-claim",
        deletionProgress: sessionDeletionProgress("document-1"),
      };

      expect(Option.isSome(yield* outbox.retainDeletionPreparation(input))).toBe(true);
      expect(Option.isSome(yield* outbox.retainDeletionPreparation(input))).toBe(true);
      const conflicting = yield* outbox
        .retainDeletionPreparation({
          ...input,
          deletionProgress: sessionDeletionProgress("document-2"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(conflicting)).toBe(true);
    }),
  ),
);

it.effect("does not advance a Session until its prior operation completes", () =>
  withDatabase(({ storage }) =>
    Effect.gen(function* () {
      const outbox = makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage)));
      yield* outbox.enqueueDeletion(deletion("delete-first", "session-1"));
      yield* outbox.enqueueDeletion(deletion("delete-second", "session-1"));

      const first = yield* outbox.claimNext(now, liveLease, "claim-first");
      expect(Option.getOrThrow(first).outboxId).toBe("delete-first");
      expect(yield* outbox.claimNext(now, liveLease, "claim-blocked")).toEqual(Option.none());

      yield* outbox.complete(Option.getOrThrow(first), now);
      const second = yield* outbox.claimNext(now, liveLease, "claim-second");
      expect(Option.getOrThrow(second).outboxId).toBe("delete-second");
    }),
  ),
);

it.effect("retains per-target deletion progress across claim retry and Agent restart", () =>
  withDatabase(({ storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const outbox = makeMemoryProviderOutboxStore(db);
      yield* outbox.enqueueDeletion(forgetKnowledgeDeletion("forget-1"));
      const claimed = Option.getOrThrow(yield* outbox.claimNext(now, liveLease, "claim-1"));

      expect(
        yield* outbox.recordDeletionProgress(claimed, {
          _tag: "ForgetKnowledge",
          completedMemoryIds: [MemoryProvider.KnowledgeMemoryId.make("memory-1")],
        }),
      ).toBe(true);
      expect(yield* outbox.retry(claimed, past, "authority changed")).toBe(true);

      const restarted = makeMemoryProviderOutboxStore(db);
      const resumed = Option.getOrThrow(yield* restarted.claimNext(now, extendedLease, "claim-2"));
      expect(resumed.deletionProgress).toEqual({
        _tag: "ForgetKnowledge",
        completedMemoryIds: ["memory-1"],
      });
    }),
  ),
);

it.effect("keeps Knowledge deletion leased until immediate Core Memory correction commits", () =>
  withDatabase(({ storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const outbox = makeMemoryProviderOutboxStore(db);
      const preparation = Option.getOrThrow(
        yield* outbox.retainDeletionPreparation({
          ...forgetKnowledgeDeletion("forget-preparing"),
          claimExpiresAt: liveLease,
          claimToken: "initial-correction",
          deletionProgress: {
            _tag: "ForgetKnowledge",
            completedMemoryIds: [MemoryProvider.KnowledgeMemoryId.make("memory-1")],
          },
        }),
      );

      expect(preparation.deletionProgress).toEqual({
        _tag: "ForgetKnowledge",
        completedMemoryIds: ["memory-1"],
      });
      expect(yield* outbox.claimNext(now, extendedLease, "provider-too-early")).toEqual(
        Option.none(),
      );
      expect(yield* outbox.releaseDeletionPreparation(preparation, now)).toBe(true);

      const restarted = makeMemoryProviderOutboxStore(db);
      const providerClaim = Option.getOrThrow(
        yield* restarted.claimNext(now, extendedLease, "provider-after-correction"),
      );
      expect(providerClaim.outboxId).toBe("forget-preparing");
      expect(providerClaim.payload._tag).toBe("ForgetKnowledge");
      expect(providerClaim.deletionProgress).toEqual({
        _tag: "ForgetKnowledge",
        completedMemoryIds: ["memory-1"],
      });
    }),
  ),
);

it.effect("cancels untouched Knowledge deletion when immediate correction fails", () =>
  withDatabase(({ storage }) =>
    Effect.gen(function* () {
      const outbox = makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage)));
      const preparation = Option.getOrThrow(
        yield* outbox.retainDeletionPreparation({
          ...forgetKnowledgeDeletion("forget-cancelled"),
          claimExpiresAt: liveLease,
          claimToken: "failed-correction",
        }),
      );

      expect(yield* outbox.cancelDeletionPreparation(preparation)).toBe(true);
      expect(
        yield* outbox.claimNext(extendedLease, extendedLease, "provider-after-failure"),
      ).toEqual(Option.none());
      expect(yield* outbox.hasRetryableWork).toBe(false);
    }),
  ),
);

it.effect("reclaims a crashed Knowledge preparation and corrects before provider deletion", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const outbox = makeMemoryProviderOutboxStore(db);
      yield* outbox.retainDeletionPreparation({
        ...forgetKnowledgeDeletion("forget-crashed-preparation"),
        claimExpiresAt: past,
        claimToken: "crashed-initial-correction",
        enqueuedAt: past,
      });
      const events: Array<string> = [];
      const provider = providerStub({
        forgetKnowledge: ({ memoryId }) =>
          Effect.sync(() => {
            events.push(`provider:${memoryId}`);
            return { _tag: "Deleted" as const };
          }),
      });

      yield* reconcileMemoryProviderOutbox(outbox, {
        authorizeDeletion: () => Effect.succeed({ _tag: "Permitted" as const }),
        prepareDeletion: () =>
          Effect.sync(() => {
            events.push("correct");
          }),
      }).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(events).toEqual(["correct", "provider:memory-1", "provider:memory-2"]);
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE outbox_id = 'forget-crashed-preparation'",
          )
          .get(),
      ).toEqual({ status: "completed" });
    }),
  ),
);

it.effect("orders User deletion behind earlier Session conversation work", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      const db = makeAgentDb(asDurableObjectStorage(storage));
      yield* makeAgentStore(db).recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      const outbox = makeMemoryProviderOutboxStore(db);
      yield* outbox.enqueueDeletion({
        enqueuedAt: now,
        outboxId: MemoryProviderOutboxId.make("delete-user-1"),
        payload: { _tag: "DeleteUserKnowledge", userId: UserId.make("user-1") },
      });

      const first = yield* outbox.claimNext(now, liveLease, "claim-append");
      expect(Option.getOrThrow(first).payload._tag).toBe("SaveConversation");
      expect(yield* outbox.claimNext(now, liveLease, "claim-blocked-delete")).toEqual(
        Option.none(),
      );

      yield* outbox.complete(Option.getOrThrow(first), now);
      const deletion = yield* outbox.claimNext(now, liveLease, "claim-delete");
      expect(Option.getOrThrow(deletion).payload._tag).toBe("DeleteUserKnowledge");
    }),
  ),
);

it.effect("terminalizes claimed append work while deleting historical Session ownership", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const store = makeAgentStore(db);
      yield* store.initialize(AgentId.make("agent-1"), {
        agentId: AgentId.make("agent-1"),
        initializationId: AgentInitializationId.make("initialization-1"),
        initializedAt: now,
        routeId: ConversationRouteId.make("route-1"),
        sessionId: SessionId.make("session-1"),
      });
      yield* store.replaceCurrentSession({
        expectedCurrentSessionId: SessionId.make("session-1"),
        replacedAt: now,
        replacementSessionId: SessionId.make("session-2"),
        routeId: ConversationRouteId.make("route-1"),
      });
      yield* store.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      database
        .prepare(
          `UPDATE osfo_memory_provider_outbox
          SET provider_accepted_at = ?, provider_document_id = 'document-1',
            provider_status = 'processing',
            usage_json = '{"completedNonModelCost":[{"activity":"conversationsAndMemory","ratedCostUsdMicros":"10","resourcePriceVersion":"resource-prices-2026-08-22"}]}'
          WHERE operation_type = 'saveConversation'`,
        )
        .run(now);
      const outbox = makeMemoryProviderOutboxStore(db);
      const staleAppendClaim = Option.getOrThrow(
        yield* outbox.claimNext(now, liveLease, "stale-append-claim"),
      );
      expect(staleAppendClaim.payload._tag).toBe("SaveConversation");
      const historical = Session.create(thinkSqlProvider(database)).forSession("session-1");
      const current = Session.create(thinkSqlProvider(database)).forSession("session-2");
      yield* seedThinkHistory(historical, "historical");
      yield* seedThinkHistory(current, "current");

      yield* deleteLocalSession(
        {
          replacementSessionId: SessionId.make("unused-replacement"),
          sessionId: SessionId.make("session-1"),
        },
        {
          activateCurrentSession: Effect.die(new Error("Historical deletion activated Session")),
          authorizeDeletion: () => Effect.void,
          clearMessages: () => Effect.promise(() => historical.clearMessages()),
          inspect: store.inspect().pipe(Effect.orDie),
          ownsSession: (sessionId) => store.ownsSession(sessionId).pipe(Effect.orDie),
          replacedAt: Effect.succeed(now),
          replaceCurrentSession: () =>
            Effect.die(new Error("Historical deletion replaced current Session")),
          rollbackCurrentSessionReplacement: () =>
            Effect.die(new Error("Historical deletion rolled back a replacement")),
          settle: (sessionId) =>
            store
              .deleteHistoricalSession({
                authorization: authorizedDeletion("delete-session-1", sessionId).payload
                  .authorization,
                deletedAt: now,
                outboxId: MemoryProviderOutboxId.make("delete-session-1"),
                sessionId,
                userId: UserId.make("user-1"),
              })
              .pipe(Effect.orDie),
        },
      );

      expect(
        database.prepare("SELECT session_id FROM osfo_session_ownership ORDER BY session_id").all(),
      ).toEqual([{ session_id: "session-2" }]);
      expect(countRows(database, "osfo_committed_turns")).toBe(0);
      expect(thinkSessionCounts(database, "session-1")).toEqual({
        compactions: 0,
        fts: 0,
        messages: 0,
      });
      expect(thinkSessionCounts(database, "session-2")).toEqual({
        compactions: 1,
        fts: 2,
        messages: 2,
      });
      expect(
        database
          .prepare(
            "SELECT initial_session_id FROM osfo_agent_initialization WHERE singleton_key = 'agent'",
          )
          .get(),
      ).toEqual({ initial_session_id: "session-2" });
      expect(
        database
          .prepare(
            `SELECT operation_type, outbox_id, provider_status, status
            FROM osfo_memory_provider_outbox ORDER BY sequence`,
          )
          .all(),
      ).toEqual([
        {
          operation_type: "saveConversation",
          outbox_id: "conversation:9:session-1:assistant-1",
          provider_status: "processing",
          status: "completed",
        },
        {
          operation_type: "deleteSessionConversation",
          outbox_id: "delete-session-1",
          provider_status: null,
          status: "pending",
        },
      ]);

      expect(yield* outbox.hasUnsettledProviderConversationWork).toBe(false);
      expect(yield* outbox.isClaimCurrent(staleAppendClaim)).toBe(false);
      yield* outbox.expediteProcessingConversationWork(now);
      expect(
        database
          .prepare(
            `SELECT claim_expires_at, claim_token, completed_at, status
            FROM osfo_memory_provider_outbox
            WHERE operation_type = 'saveConversation'`,
          )
          .get(),
      ).toEqual({
        claim_expires_at: null,
        claim_token: null,
        completed_at: now,
        status: "completed",
      });
      expect(yield* outbox.awaitProvider(staleAppendClaim, "processing", now)).toBe(false);
      const next = Option.getOrThrow(yield* outbox.claimNext(now, liveLease, "deletion-claim"));
      expect(next.payload._tag).toBe("DeleteSessionConversation");
    }),
  ),
);

it.effect("does not save a claimed append after historical Session deletion terminalizes it", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const store = makeAgentStore(db);
      yield* store.initialize(AgentId.make("agent-1"), {
        agentId: AgentId.make("agent-1"),
        initializationId: AgentInitializationId.make("initialization-1"),
        initializedAt: now,
        routeId: ConversationRouteId.make("route-1"),
        sessionId: SessionId.make("session-1"),
      });
      yield* store.replaceCurrentSession({
        expectedCurrentSessionId: SessionId.make("session-1"),
        replacedAt: now,
        replacementSessionId: SessionId.make("session-2"),
        routeId: ConversationRouteId.make("route-1"),
      });
      yield* store.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );
      const outbox = makeMemoryProviderOutboxStore(db);
      const reachedDeletionFence = yield* Deferred.make<void>();
      const resumeAfterDeletion = yield* Deferred.make<void>();
      let providerCalls = 0;
      const provider = providerStub({
        saveConversation: () => {
          providerCalls += 1;
          return Effect.die(new Error("A deleted Session was recreated at the provider"));
        },
      });
      const reconciliation = Effect.scoped(
        reconcileMemoryProviderOutbox(outbox, {
          ...permittedDeletionOptions,
          canSaveConversation: () =>
            Deferred.succeed(reachedDeletionFence, undefined).pipe(
              Effect.andThen(Deferred.await(resumeAfterDeletion)),
              Effect.as(true),
            ),
        }),
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );
      const reconciler = yield* reconciliation.pipe(Effect.forkChild);
      yield* Deferred.await(reachedDeletionFence);

      yield* deleteLocalSession(
        {
          replacementSessionId: SessionId.make("unused-replacement"),
          sessionId: SessionId.make("session-1"),
        },
        {
          activateCurrentSession: Effect.die(new Error("Historical deletion activated Session")),
          authorizeDeletion: () => Effect.void,
          clearMessages: () => Effect.void,
          inspect: store.inspect().pipe(Effect.orDie),
          ownsSession: (sessionId) => store.ownsSession(sessionId).pipe(Effect.orDie),
          replacedAt: Effect.succeed(now),
          replaceCurrentSession: () =>
            Effect.die(new Error("Historical deletion replaced current Session")),
          rollbackCurrentSessionReplacement: () =>
            Effect.die(new Error("Historical deletion rolled back a replacement")),
          settle: (sessionId) =>
            store
              .deleteHistoricalSession({
                authorization: authorizedDeletion("delete-session-1", sessionId).payload
                  .authorization,
                deletedAt: now,
                outboxId: MemoryProviderOutboxId.make("delete-session-1"),
                sessionId,
                userId: UserId.make("user-1"),
              })
              .pipe(Effect.orDie),
        },
      );
      yield* Deferred.succeed(resumeAfterDeletion, undefined);
      yield* Fiber.join(reconciler);

      expect(providerCalls).toBe(0);
      expect(
        database
          .prepare(
            `SELECT provider_document_id, status FROM osfo_memory_provider_outbox
            WHERE operation_type = 'saveConversation'`,
          )
          .get(),
      ).toEqual({ provider_document_id: null, status: "completed" });
      expect(
        database
          .prepare("SELECT session_id FROM osfo_session_ownership WHERE session_id = 'session-1'")
          .get(),
      ).toBeUndefined();
    }),
  ),
);

it.effect("drains an in-flight provider save before terminalizing Session append work", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const store = makeAgentStore(db);
      yield* store.initialize(AgentId.make("agent-1"), {
        agentId: AgentId.make("agent-1"),
        initializationId: AgentInitializationId.make("initialization-1"),
        initializedAt: now,
        routeId: ConversationRouteId.make("route-1"),
        sessionId: SessionId.make("session-1"),
      });
      yield* store.replaceCurrentSession({
        expectedCurrentSessionId: SessionId.make("session-1"),
        replacedAt: now,
        replacementSessionId: SessionId.make("session-2"),
        routeId: ConversationRouteId.make("route-1"),
      });
      yield* store.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      const outbox = makeMemoryProviderOutboxStore(db);
      const saveGate = makeProviderConversationSaveGate();
      const providerSaveStarted = yield* Deferred.make<void>();
      const releaseProviderSave = yield* Deferred.make<void>();
      const deletionAttempted = yield* Deferred.make<void>();
      const providerDocuments = new Set<string>();
      const provider = providerStub({
        deleteSessionConversation: ({ documentId }) =>
          Effect.sync(() => {
            providerDocuments.delete(documentId);
            return { _tag: "Deleted" as const };
          }),
        saveConversation: () =>
          Deferred.succeed(providerSaveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseProviderSave)),
            Effect.tap(() => Effect.sync(() => providerDocuments.add("document-1"))),
            Effect.as(conversationSaveResult("document-1", "processing")),
          ),
      });
      const reconciliation = Effect.scoped(
        reconcileMemoryProviderOutbox(outbox, {
          ...permittedDeletionOptions,
          runSaveConversation: saveGate.runSave,
        }),
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );
      const reconciler = yield* reconciliation.pipe(Effect.forkChild);
      yield* Deferred.await(providerSaveStarted);

      const deleting = yield* Deferred.succeed(deletionAttempted, undefined).pipe(
        Effect.andThen(
          saveGate.runSessionDeletion(
            deleteLocalSession(
              {
                replacementSessionId: SessionId.make("unused-replacement"),
                sessionId: SessionId.make("session-1"),
              },
              {
                activateCurrentSession: Effect.die(
                  new Error("Historical deletion activated Session"),
                ),
                authorizeDeletion: () => Effect.void,
                clearMessages: () => Effect.void,
                inspect: store.inspect().pipe(Effect.orDie),
                ownsSession: (sessionId) => store.ownsSession(sessionId).pipe(Effect.orDie),
                replacedAt: Effect.succeed(now),
                replaceCurrentSession: () =>
                  Effect.die(new Error("Historical deletion replaced current Session")),
                rollbackCurrentSessionReplacement: () =>
                  Effect.die(new Error("Historical deletion rolled back a replacement")),
                settle: (sessionId) =>
                  store
                    .deleteHistoricalSession({
                      authorization: authorizedDeletion("delete-session-1", sessionId).payload
                        .authorization,
                      deletedAt: now,
                      outboxId: MemoryProviderOutboxId.make("delete-session-1"),
                      sessionId,
                      userId: UserId.make("user-1"),
                    })
                    .pipe(Effect.orDie),
              },
            ),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(deletionAttempted);
      expect(
        database
          .prepare("SELECT session_id FROM osfo_session_ownership WHERE session_id = 'session-1'")
          .get(),
      ).toBeDefined();

      yield* Deferred.succeed(releaseProviderSave, undefined);
      yield* Fiber.join(reconciler);
      yield* Fiber.join(deleting);
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );
      yield* reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(providerDocuments).toEqual(new Set());
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE operation_type = 'deleteSessionConversation'",
          )
          .get(),
      ).toEqual({ status: "completed" });
    }),
  ),
);

it.effect("hands a cross-isolate late provider acceptance to durable Session deletion", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const durableStorage = asDurableObjectStorage(storage);
      const originalDb = makeAgentDb(durableStorage);
      const originalStore = makeAgentStore(originalDb);
      yield* originalStore.initialize(AgentId.make("agent-1"), {
        agentId: AgentId.make("agent-1"),
        initializationId: AgentInitializationId.make("initialization-1"),
        initializedAt: now,
        routeId: ConversationRouteId.make("route-1"),
        sessionId: SessionId.make("session-1"),
      });
      yield* originalStore.replaceCurrentSession({
        expectedCurrentSessionId: SessionId.make("session-1"),
        replacedAt: now,
        replacementSessionId: SessionId.make("session-2"),
        routeId: ConversationRouteId.make("route-1"),
      });
      yield* originalStore.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      yield* originalStore.recordCommittedTurn(
        committedTurn("assistant-2", "request-2"),
        conversationProjection("assistant-2"),
      );
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      const providerSaveStarted = yield* Deferred.make<void>();
      const releaseProviderSave = yield* Deferred.make<void>();
      const providerDocuments = new Set(["unrelated-document"]);
      const deleted: Array<string> = [];
      let deleteAttempts = 0;
      const provider = providerStub({
        deleteSessionConversation: ({ documentId }) =>
          Effect.suspend(() => {
            deleteAttempts += 1;
            if (deleteAttempts === 1) {
              return Effect.fail(
                new MemoryProvider.MemoryProviderUnavailable({
                  message: "Injected delete outage",
                  operation: "deleteSessionConversation",
                }),
              );
            }
            deleted.push(documentId);
            providerDocuments.delete(documentId);
            return Effect.succeed({ _tag: "Deleted" as const });
          }),
        findSessionConversation: () => Effect.succeed({ _tag: "AlreadyAbsent" as const }),
        saveConversation: () =>
          Deferred.succeed(providerSaveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseProviderSave)),
            Effect.tap(() => Effect.sync(() => providerDocuments.add("late-document"))),
            Effect.as(conversationSaveResult("late-document", "done")),
          ),
        verifySessionConversation: ({ documentId }) =>
          Effect.sync(() =>
            providerDocuments.has(documentId)
              ? ({ _tag: "Verified" } as const)
              : ({ _tag: "AlreadyAbsent" } as const),
          ),
      });
      const originalReconciliation = Effect.scoped(
        reconcileMemoryProviderOutbox(makeMemoryProviderOutboxStore(originalDb), {
          ...permittedDeletionOptions,
        }),
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );
      const originalIsolate = yield* originalReconciliation.pipe(Effect.forkChild);
      yield* Deferred.await(providerSaveStarted);
      database.exec(
        `UPDATE osfo_memory_provider_outbox SET claim_expires_at = '1960-01-01T00:00:00.000Z'
        WHERE operation_type = 'saveConversation' AND status = 'claimed'`,
      );
      expect(
        database
          .prepare(
            `SELECT provider_submission_ambiguous, status FROM osfo_memory_provider_outbox
            WHERE operation_type = 'saveConversation' ORDER BY sequence`,
          )
          .all(),
      ).toEqual([
        { provider_submission_ambiguous: 1, status: "claimed" },
        { provider_submission_ambiguous: 0, status: "pending" },
      ]);

      const deletionDb = makeAgentDb(durableStorage);
      yield* makeAgentStore(deletionDb).deleteHistoricalSession({
        authorization: authorizedDeletion("delete-session-1", "session-1").payload.authorization,
        deletedAt: now,
        outboxId: MemoryProviderOutboxId.make("delete-session-1"),
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      });
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      yield* reconcileMemoryProviderOutbox(
        makeMemoryProviderOutboxStore(deletionDb),
        permittedDeletionOptions,
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE operation_type = 'deleteSessionConversation'",
          )
          .get(),
      ).toEqual({ status: "pending" });

      yield* Deferred.succeed(releaseProviderSave, undefined);
      yield* Fiber.join(originalIsolate);
      const handedOff = database
        .prepare(
          `SELECT deletion_progress_json, status FROM osfo_memory_provider_outbox
          WHERE operation_type = 'deleteSessionConversation'`,
        )
        .get();
      if (handedOff === undefined || typeof handedOff.deletion_progress_json !== "string") {
        throw new Error("Session deletion progress was not retained");
      }
      const handedOffProgress = yield* Schema.decodeEffect(
        Schema.fromJsonString(MemoryProviderDeletionProgress),
      )(handedOff.deletion_progress_json).pipe(Effect.orDie);
      expect(handedOffProgress).toEqual({
        _tag: "DeleteSessionConversation",
        awaitingDiscovery: false,
        targets: [{ documentId: "late-document", status: "observed" }],
      });
      expect(handedOff.status).toBe("pending");
      expect(providerDocuments).toEqual(new Set(["late-document", "unrelated-document"]));

      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );
      yield* reconcileMemoryProviderOutbox(
        makeMemoryProviderOutboxStore(makeAgentDb(durableStorage)),
        permittedDeletionOptions,
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(deleted).toEqual(["late-document"]);
      expect(providerDocuments).toEqual(new Set(["unrelated-document"]));
      expect(
        database
          .prepare(
            `SELECT operation_type, provider_submission_ambiguous, status
            FROM osfo_memory_provider_outbox ORDER BY sequence`,
          )
          .all(),
      ).toEqual([
        {
          operation_type: "saveConversation",
          provider_submission_ambiguous: 0,
          status: "completed",
        },
        {
          operation_type: "saveConversation",
          provider_submission_ambiguous: 0,
          status: "completed",
        },
        {
          operation_type: "deleteSessionConversation",
          provider_submission_ambiguous: 0,
          status: "completed",
        },
      ]);
    }),
  ),
);

it.effect("retains accepted Session cleanup until a processing provider document surfaces", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const store = makeAgentStore(db);
      yield* store.initialize(AgentId.make("agent-1"), {
        agentId: AgentId.make("agent-1"),
        initializationId: AgentInitializationId.make("initialization-1"),
        initializedAt: now,
        routeId: ConversationRouteId.make("route-1"),
        sessionId: SessionId.make("session-1"),
      });
      yield* store.replaceCurrentSession({
        expectedCurrentSessionId: SessionId.make("session-1"),
        replacedAt: now,
        replacementSessionId: SessionId.make("session-2"),
        routeId: ConversationRouteId.make("route-1"),
      });
      yield* store.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      database
        .prepare(
          `UPDATE osfo_memory_provider_outbox
            SET provider_accepted_at = ?, provider_document_id = 'document-1',
              provider_status = 'processing',
              usage_json = '{"completedNonModelCost":[{"activity":"conversationsAndMemory","ratedCostUsdMicros":"10","resourcePriceVersion":"resource-prices-2026-08-22"}]}'
            WHERE operation_type = 'saveConversation'`,
        )
        .run(now);

      yield* store.deleteHistoricalSession({
        authorization: authorizedDeletion("delete-session-1", "session-1").payload.authorization,
        deletedAt: now,
        outboxId: MemoryProviderOutboxId.make("delete-session-1"),
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      });
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      let surfaced = false;
      const providerDocuments = new Set(["document-1", "unrelated-document"]);
      const deleted: Array<string> = [];
      const provider = providerStub({
        deleteSessionConversation: ({ documentId }) =>
          Effect.sync(() => {
            deleted.push(documentId);
            providerDocuments.delete(documentId);
            return { _tag: "Deleted" as const };
          }),
        findSessionConversation: () =>
          Effect.sync(() =>
            surfaced
              ? ({
                  _tag: "Found",
                  documentIds: [MemoryProvider.ProviderDocumentId.make("document-1")],
                } as const)
              : ({ _tag: "AlreadyAbsent" } as const),
          ),
        verifySessionConversation: () =>
          Effect.succeed(
            surfaced ? ({ _tag: "Verified" } as const) : ({ _tag: "AlreadyAbsent" } as const),
          ),
      });

      yield* reconcileMemoryProviderOutbox(
        makeMemoryProviderOutboxStore(db),
        permittedDeletionOptions,
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE operation_type = 'deleteSessionConversation'",
          )
          .get(),
      ).toEqual({ status: "pending" });
      expect(deleted).toEqual([]);

      surfaced = true;
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );
      yield* reconcileMemoryProviderOutbox(
        makeMemoryProviderOutboxStore(db),
        permittedDeletionOptions,
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(deleted).toEqual(["document-1"]);
      expect(providerDocuments).toEqual(new Set(["unrelated-document"]));
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE operation_type = 'deleteSessionConversation'",
          )
          .get(),
      ).toEqual({ status: "completed" });
    }),
  ),
);

it.effect(
  "retains possibly accepted Session cleanup across restart until its provider document surfaces",
  () =>
    withDatabase(({ database, storage }) =>
      Effect.gen(function* () {
        const db = makeAgentDb(asDurableObjectStorage(storage));
        const store = makeAgentStore(db);
        const outbox = makeMemoryProviderOutboxStore(db);
        yield* store.initialize(AgentId.make("agent-1"), {
          agentId: AgentId.make("agent-1"),
          initializationId: AgentInitializationId.make("initialization-1"),
          initializedAt: now,
          routeId: ConversationRouteId.make("route-1"),
          sessionId: SessionId.make("session-1"),
        });
        yield* store.replaceCurrentSession({
          expectedCurrentSessionId: SessionId.make("session-1"),
          replacedAt: now,
          replacementSessionId: SessionId.make("session-2"),
          routeId: ConversationRouteId.make("route-1"),
        });
        yield* store.recordCommittedTurn(
          committedTurn("assistant-1", "request-1"),
          conversationProjection("assistant-1"),
        );
        const saveClaim = Option.getOrThrow(
          yield* outbox.claimNext(now, liveLease, "possibly-accepted-save"),
        );
        yield* outbox.retainAmbiguousProviderSubmission(
          saveClaim,
          "The provider response was lost",
        );

        yield* store.deleteHistoricalSession({
          authorization: authorizedDeletion("delete-session-1", "session-1").payload.authorization,
          deletedAt: now,
          outboxId: MemoryProviderOutboxId.make("delete-session-1"),
          sessionId: SessionId.make("session-1"),
          userId: UserId.make("user-1"),
        });
        database.exec(
          "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
        );

        let surfaced = false;
        const providerDocuments = new Set(["document-1", "unrelated-document"]);
        const deleted: Array<string> = [];
        const provider = providerStub({
          deleteSessionConversation: ({ documentId }) =>
            Effect.sync(() => {
              deleted.push(documentId);
              providerDocuments.delete(documentId);
              return { _tag: "Deleted" as const };
            }),
          findSessionConversation: () =>
            Effect.sync(() =>
              surfaced
                ? ({
                    _tag: "Found",
                    documentIds: [MemoryProvider.ProviderDocumentId.make("document-1")],
                  } as const)
                : ({ _tag: "AlreadyAbsent" } as const),
            ),
        });

        yield* reconcileMemoryProviderOutbox(
          makeMemoryProviderOutboxStore(db),
          permittedDeletionOptions,
        ).pipe(
          Effect.provideService(MemoryProvider.Service, provider),
          Effect.provideService(Db.Service, unavailableDatabase),
          Effect.provide(BrowserCrypto.layer),
        );
        expect(
          database
            .prepare(
              "SELECT status FROM osfo_memory_provider_outbox WHERE operation_type = 'deleteSessionConversation'",
            )
            .get(),
        ).toEqual({ status: "pending" });
        expect(deleted).toEqual([]);

        surfaced = true;
        database.exec(
          "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
        );
        yield* reconcileMemoryProviderOutbox(
          makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage))),
          permittedDeletionOptions,
        ).pipe(
          Effect.provideService(MemoryProvider.Service, provider),
          Effect.provideService(Db.Service, unavailableDatabase),
          Effect.provide(BrowserCrypto.layer),
        );

        expect(deleted).toEqual(["document-1"]);
        expect(providerDocuments).toEqual(new Set(["unrelated-document"]));
        expect(
          database
            .prepare(
              "SELECT status FROM osfo_memory_provider_outbox WHERE operation_type = 'deleteSessionConversation'",
            )
            .get(),
        ).toEqual({ status: "completed" });
      }),
    ),
);

it.effect("rechecks before replacing, clearing, and settling the current Session", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const store = makeAgentStore(db);
      yield* store.initialize(AgentId.make("agent-1"), {
        agentId: AgentId.make("agent-1"),
        initializationId: AgentInitializationId.make("initialization-1"),
        initializedAt: now,
        routeId: ConversationRouteId.make("route-1"),
        sessionId: SessionId.make("session-1"),
      });
      const current = Session.create(thinkSqlProvider(database)).forSession("session-1");
      yield* seedThinkHistory(current, "current");
      const events: Array<string> = [];

      yield* deleteLocalSession(
        {
          replacementSessionId: SessionId.make("session-2"),
          sessionId: SessionId.make("session-1"),
        },
        {
          activateCurrentSession: Effect.sync(() => events.push("activate")).pipe(Effect.asVoid),
          authorizeDeletion: () => Effect.sync(() => events.push("recheck")),
          clearMessages: () =>
            Effect.sync(() => events.push("clear")).pipe(
              Effect.andThen(Effect.promise(() => current.clearMessages())),
            ),
          inspect: store.inspect().pipe(Effect.orDie),
          ownsSession: (sessionId) => store.ownsSession(sessionId).pipe(Effect.orDie),
          replacedAt: Effect.succeed(now),
          replaceCurrentSession: (replacement) =>
            Effect.sync(() => events.push("replace")).pipe(
              Effect.andThen(store.replaceCurrentSession(replacement).pipe(Effect.orDie)),
            ),
          rollbackCurrentSessionReplacement: (replacement) =>
            store.rollbackCurrentSessionReplacement(replacement).pipe(Effect.asVoid, Effect.orDie),
          settle: (sessionId) =>
            Effect.sync(() => events.push("settle")).pipe(
              Effect.andThen(
                store
                  .deleteHistoricalSession({
                    authorization: authorizedDeletion("delete-session-current", sessionId).payload
                      .authorization,
                    deletedAt: now,
                    outboxId: MemoryProviderOutboxId.make("delete-session-current"),
                    sessionId,
                    userId: UserId.make("user-1"),
                  })
                  .pipe(Effect.orDie),
              ),
            ),
        },
      );

      expect(events).toEqual([
        "recheck",
        "replace",
        "recheck",
        "activate",
        "recheck",
        "clear",
        "recheck",
        "settle",
      ]);
      expect(yield* store.inspect()).toMatchObject({ currentSessionId: "session-2" });
      expect(thinkSessionCounts(database, "session-1")).toEqual({
        compactions: 0,
        fts: 0,
        messages: 0,
      });
    }),
  ),
);

it.effect("atomically rolls back a replacement when authority changes before activation", () =>
  withDatabase(({ storage }) =>
    Effect.gen(function* () {
      const store = makeAgentStore(makeAgentDb(asDurableObjectStorage(storage)));
      yield* store.initialize(AgentId.make("agent-1"), {
        agentId: AgentId.make("agent-1"),
        initializationId: AgentInitializationId.make("initialization-1"),
        initializedAt: now,
        routeId: ConversationRouteId.make("route-1"),
        sessionId: SessionId.make("session-1"),
      });
      let checks = 0;
      const result = yield* deleteLocalSession(
        {
          replacementSessionId: SessionId.make("session-2"),
          sessionId: SessionId.make("session-1"),
        },
        {
          activateCurrentSession: Effect.die(
            new Error("Authority-changed replacement was activated"),
          ),
          authorizeDeletion: () =>
            Effect.suspend(() => {
              checks += 1;
              return checks === 1 ? Effect.void : Effect.fail("authority changed" as const);
            }),
          clearMessages: () => Effect.die(new Error("Authority-changed Session was cleared")),
          inspect: store.inspect().pipe(Effect.orDie),
          ownsSession: (sessionId) => store.ownsSession(sessionId).pipe(Effect.orDie),
          replacedAt: Effect.succeed(now),
          replaceCurrentSession: (replacement) =>
            store.replaceCurrentSession(replacement).pipe(Effect.orDie),
          rollbackCurrentSessionReplacement: (replacement) =>
            store.rollbackCurrentSessionReplacement(replacement).pipe(
              Effect.filterOrFail(
                (rolledBack) => rolledBack,
                () => "rollback failed" as const,
              ),
              Effect.asVoid,
              Effect.orDie,
            ),
          settle: () => Effect.die(new Error("Authority-changed Session was settled")),
        },
      ).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(yield* store.inspect()).toMatchObject({ currentSessionId: "session-1" });
      expect(yield* store.readSessionIds).toEqual([SessionId.make("session-1")]);
    }),
  ),
);

it.effect("retains SQLite Session ownership when authority changes after history clearing", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const store = makeAgentStore(db);
      yield* store.initialize(AgentId.make("agent-1"), {
        agentId: AgentId.make("agent-1"),
        initializationId: AgentInitializationId.make("initialization-1"),
        initializedAt: now,
        routeId: ConversationRouteId.make("route-1"),
        sessionId: SessionId.make("session-1"),
      });
      yield* store.replaceCurrentSession({
        expectedCurrentSessionId: SessionId.make("session-1"),
        replacedAt: now,
        replacementSessionId: SessionId.make("session-2"),
        routeId: ConversationRouteId.make("route-1"),
      });
      const historical = Session.create(thinkSqlProvider(database)).forSession("session-1");
      yield* seedThinkHistory(historical, "historical");
      let recheckCount = 0;

      const deletion = (authorizeDeletion: () => Effect.Effect<void, string>) =>
        deleteLocalSession(
          {
            replacementSessionId: SessionId.make("unused-replacement"),
            sessionId: SessionId.make("session-1"),
          },
          {
            activateCurrentSession: Effect.die(new Error("Historical Session was activated")),
            authorizeDeletion,
            clearMessages: () => Effect.promise(() => historical.clearMessages()),
            inspect: store.inspect().pipe(Effect.orDie),
            ownsSession: (sessionId) => store.ownsSession(sessionId).pipe(Effect.orDie),
            replacedAt: Effect.succeed(now),
            replaceCurrentSession: () =>
              Effect.die(new Error("Historical Session was replaced as current")),
            rollbackCurrentSessionReplacement: () =>
              Effect.die(new Error("Historical Session replacement was rolled back")),
            settle: (sessionId) =>
              store
                .deleteHistoricalSession({
                  authorization: authorizedDeletion("delete-session-authority-drift", sessionId)
                    .payload.authorization,
                  deletedAt: now,
                  outboxId: MemoryProviderOutboxId.make("delete-session-authority-drift"),
                  sessionId,
                  userId: UserId.make("user-1"),
                })
                .pipe(Effect.orDie),
          },
        );

      const denied = yield* deletion(() => {
        recheckCount += 1;
        return recheckCount === 1 ? Effect.void : Effect.fail("authority changed");
      }).pipe(Effect.result);
      expect(Result.isFailure(denied)).toBe(true);
      expect(thinkSessionCounts(database, "session-1")).toEqual({
        compactions: 0,
        fts: 0,
        messages: 0,
      });
      expect(
        database
          .prepare("SELECT session_id FROM osfo_session_ownership WHERE session_id = 'session-1'")
          .get(),
      ).toEqual({ session_id: "session-1" });
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE outbox_id = 'delete-session-authority-drift'",
          )
          .get(),
      ).toBeUndefined();

      yield* deletion(() => Effect.void);
      expect(
        database
          .prepare("SELECT session_id FROM osfo_session_ownership WHERE session_id = 'session-1'")
          .get(),
      ).toBeUndefined();
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE outbox_id = 'delete-session-authority-drift'",
          )
          .get(),
      ).toEqual({ status: "pending" });
    }),
  ),
);

it.effect("keeps a later conversation snapshot blocked while the accepted document processes", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const agentStore = makeAgentStore(db);
      yield* agentStore.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      yield* agentStore.recordCommittedTurn(
        committedTurn("assistant-2", "request-2"),
        conversationProjection("assistant-2"),
      );
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      const saved: Array<string> = [];
      const provider = providerStub({
        saveConversation: ({ conversation }) => {
          saved.push(conversation.messages.at(-1)?.content ?? "");
          return Effect.succeed(conversationSaveResult("document-1", "processing"));
        },
      });

      yield* reconcileMemoryProviderOutbox(
        makeMemoryProviderOutboxStore(db),
        permittedDeletionOptions,
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(saved).toEqual(["I will remember it"]);
      expect(
        database
          .prepare(
            `SELECT provider_document_id, provider_status, status
              FROM osfo_memory_provider_outbox
              ORDER BY sequence`,
          )
          .all(),
      ).toEqual([
        { provider_document_id: "document-1", provider_status: "processing", status: "pending" },
        { provider_document_id: null, provider_status: null, status: "pending" },
      ]);
    }),
  ),
);

it.effect(
  "polls the accepted document and releases the next snapshot when processing finishes",
  () =>
    withDatabase(({ database, storage }) =>
      Effect.gen(function* () {
        seedSession(database);
        const db = makeAgentDb(asDurableObjectStorage(storage));
        const agentStore = makeAgentStore(db);
        yield* agentStore.recordCommittedTurn(
          committedTurn("assistant-1", "request-1"),
          conversationProjection("assistant-1"),
        );
        yield* agentStore.recordCommittedTurn(
          committedTurn("assistant-2", "request-2"),
          conversationProjection("assistant-2"),
        );
        database.exec(
          "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
        );

        let saveCount = 0;
        let statusCount = 0;
        const provider = providerStub({
          getConversationStatus: () => {
            statusCount += 1;
            return Effect.succeed({ processingStatus: "done" });
          },
          saveConversation: () => {
            saveCount += 1;
            return Effect.succeed(conversationSaveResult(`document-${saveCount}`, "processing"));
          },
        });
        const outbox = makeMemoryProviderOutboxStore(db);

        yield* reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions).pipe(
          Effect.provideService(MemoryProvider.Service, provider),
          Effect.provideService(Db.Service, unavailableDatabase),
          Effect.provide(BrowserCrypto.layer),
        );
        database
          .prepare(
            `UPDATE osfo_memory_provider_outbox
            SET available_at = ?
            WHERE sequence = 1`,
          )
          .run(past);

        yield* reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions).pipe(
          Effect.provideService(MemoryProvider.Service, provider),
          Effect.provideService(Db.Service, failingUsageDatabase),
          Effect.provide(BrowserCrypto.layer),
        );

        expect({ saveCount, statusCount }).toEqual({ saveCount: 2, statusCount: 1 });
        expect(
          database
            .prepare(
              `SELECT last_error, provider_document_id, provider_status, status
              FROM osfo_memory_provider_outbox
              ORDER BY sequence`,
            )
            .all(),
        ).toEqual([
          {
            last_error: null,
            provider_document_id: "document-1",
            provider_status: "done",
            status: "completed",
          },
          {
            last_error: null,
            provider_document_id: "document-2",
            provider_status: "processing",
            status: "pending",
          },
        ]);
      }),
    ),
);

it.effect("deletes every accepted Session document across delayed surfacing and restart", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const store = makeAgentStore(db);
      yield* store.initialize(AgentId.make("agent-1"), {
        agentId: AgentId.make("agent-1"),
        initializationId: AgentInitializationId.make("initialization-1"),
        initializedAt: now,
        routeId: ConversationRouteId.make("route-1"),
        sessionId: SessionId.make("session-1"),
      });
      yield* store.replaceCurrentSession({
        expectedCurrentSessionId: SessionId.make("session-1"),
        replacedAt: now,
        replacementSessionId: SessionId.make("session-2"),
        routeId: ConversationRouteId.make("route-1"),
      });
      yield* store.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      yield* store.recordCommittedTurn(
        committedTurn("assistant-2", "request-2"),
        conversationProjection("assistant-2"),
      );
      yield* store.recordCommittedTurn(
        committedTurn("assistant-3", "request-3"),
        conversationProjection("assistant-3"),
      );
      database
        .prepare(
          `UPDATE osfo_memory_provider_outbox
            SET completed_at = ?, provider_accepted_at = ?, provider_document_id = 'document-1',
              provider_status = 'done', status = 'completed',
              usage_json = '{"completedNonModelCost":[{"activity":"conversationsAndMemory","ratedCostUsdMicros":"10","resourcePriceVersion":"resource-prices-2026-08-22"}]}'
            WHERE sequence = 1`,
        )
        .run(now, now);
      database
        .prepare(
          `UPDATE osfo_memory_provider_outbox
            SET provider_accepted_at = ?, provider_document_id = 'document-2',
              provider_status = 'processing',
              usage_json = '{"completedNonModelCost":[{"activity":"conversationsAndMemory","ratedCostUsdMicros":"10","resourcePriceVersion":"resource-prices-2026-08-22"}]}'
            WHERE sequence = 2`,
        )
        .run(now);
      database
        .prepare(
          `UPDATE osfo_memory_provider_outbox
            SET provider_submission_ambiguous = 1
            WHERE sequence = 3`,
        )
        .run();

      yield* store.deleteHistoricalSession({
        authorization: authorizedDeletion("delete-session-1", "session-1").payload.authorization,
        deletedAt: now,
        outboxId: MemoryProviderOutboxId.make("delete-session-1"),
        sessionId: SessionId.make("session-1"),
        userId: UserId.make("user-1"),
      });
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      const providerDocuments = new Set(["document-1", "unrelated-document"]);
      const deleted: Array<string> = [];
      const provider = providerStub({
        deleteSessionConversation: ({ documentId }) =>
          Effect.sync(() => {
            deleted.push(documentId);
            providerDocuments.delete(documentId);
            return { _tag: "Deleted" as const };
          }),
        findSessionConversation: () =>
          Effect.sync(() =>
            providerDocuments.has("document-3")
              ? ({
                  _tag: "Found",
                  documentIds: [MemoryProvider.ProviderDocumentId.make("document-3")],
                } as const)
              : ({ _tag: "AlreadyAbsent" } as const),
          ),
        verifySessionConversation: ({ documentId }) =>
          Effect.sync(() =>
            providerDocuments.has(documentId)
              ? ({ _tag: "Verified" } as const)
              : ({ _tag: "AlreadyAbsent" } as const),
          ),
      });

      yield* reconcileMemoryProviderOutbox(
        makeMemoryProviderOutboxStore(db),
        permittedDeletionOptions,
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );
      expect(deleted).toEqual(["document-1"]);
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE operation_type = 'deleteSessionConversation'",
          )
          .get(),
      ).toEqual({ status: "pending" });

      providerDocuments.add("document-2");
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );
      yield* reconcileMemoryProviderOutbox(
        makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage))),
        permittedDeletionOptions,
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(deleted).toEqual(["document-1", "document-2"]);
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE operation_type = 'deleteSessionConversation'",
          )
          .get(),
      ).toEqual({ status: "pending" });

      providerDocuments.add("document-3");
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );
      yield* reconcileMemoryProviderOutbox(
        makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage))),
        permittedDeletionOptions,
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(deleted).toEqual(["document-1", "document-2", "document-3"]);
      expect(providerDocuments).toEqual(new Set(["unrelated-document"]));
      expect(
        database
          .prepare(
            "SELECT status FROM osfo_memory_provider_outbox WHERE operation_type = 'deleteSessionConversation'",
          )
          .get(),
      ).toEqual({ status: "completed" });
    }),
  ),
);

it.effect("resumes status polling after restart without resending an accepted snapshot", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      seedSession(database);
      const db = makeAgentDb(asDurableObjectStorage(storage));
      yield* makeAgentStore(db).recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      let saveCount = 0;
      let statusCount = 0;
      const provider = providerStub({
        getConversationStatus: () => {
          statusCount += 1;
          return Effect.fail(
            new MemoryProvider.MemoryProviderUnavailable({
              message: "Provider is unavailable",
              operation: "getConversationStatus",
            }),
          );
        },
        saveConversation: () => {
          saveCount += 1;
          return Effect.succeed(conversationSaveResult("document-1", "processing"));
        },
      });

      yield* reconcileMemoryProviderOutbox(
        makeMemoryProviderOutboxStore(db),
        permittedDeletionOptions,
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      const restarted = makeMemoryProviderOutboxStore(db);
      yield* reconcileMemoryProviderOutbox(restarted, permittedDeletionOptions).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect({ saveCount, statusCount }).toEqual({ saveCount: 1, statusCount: 1 });
      expect(
        database
          .prepare(
            `SELECT available_at, last_error, provider_document_id, provider_status, status
              FROM osfo_memory_provider_outbox`,
          )
          .get(),
      ).toEqual({
        available_at: "2026-08-23T12:00:30.000Z",
        last_error: "Provider is unavailable",
        provider_document_id: "document-1",
        provider_status: "processing",
        status: "pending",
      });
    }),
  ),
);

it.effect("terminalizes an accepted document with an invalid status without resending it", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const agentStore = makeAgentStore(db);
      yield* agentStore.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      yield* agentStore.recordCommittedTurn(
        committedTurn("assistant-2", "request-2"),
        conversationProjection("assistant-2"),
      );
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      let saveCount = 0;
      const provider = providerStub({
        saveConversation: () => {
          saveCount += 1;
          const accepted = conversationSaveResult("document-1", "processing");
          return Effect.fail(
            new MemoryProvider.MemoryProviderAcceptanceStatusInvalid({
              documentId: accepted.documentId,
              message: "The MemoryProvider accepted the conversation with an invalid status",
              operation: "saveConversation",
              usage: accepted.usage,
            }),
          );
        },
      });
      const outbox = makeMemoryProviderOutboxStore(db);

      yield* reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );
      yield* reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(saveCount).toBe(1);
      expect(yield* outbox.hasRetryableWork).toBe(false);
      expect(
        database
          .prepare(
            `SELECT last_error, provider_accepted_at, provider_document_id, provider_status, status
              FROM osfo_memory_provider_outbox
              ORDER BY sequence`,
          )
          .all(),
      ).toEqual([
        {
          last_error: "The MemoryProvider accepted the conversation with an invalid status",
          provider_accepted_at: expect.any(String),
          provider_document_id: "document-1",
          provider_status: "failed",
          status: "failed",
        },
        {
          last_error: null,
          provider_accepted_at: null,
          provider_document_id: null,
          provider_status: null,
          status: "pending",
        },
      ]);
    }),
  ),
);

it.effect("keeps a terminal provider failure durable without releasing later work", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const agentStore = makeAgentStore(db);
      yield* agentStore.recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      yield* agentStore.recordCommittedTurn(
        committedTurn("assistant-2", "request-2"),
        conversationProjection("assistant-2"),
      );
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );

      let saveCount = 0;
      let statusCount = 0;
      const provider = providerStub({
        getConversationStatus: () => {
          statusCount += 1;
          return Effect.fail(
            new MemoryProvider.MemoryProviderRejected({
              message: "Conversation processing failed",
              operation: "getConversationStatus",
            }),
          );
        },
        saveConversation: () => {
          saveCount += 1;
          return Effect.succeed(conversationSaveResult("document-1", "processing"));
        },
      });
      const outbox = makeMemoryProviderOutboxStore(db);

      yield* reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );
      database.exec(
        "UPDATE osfo_memory_provider_outbox SET available_at = '1960-01-01T00:00:00.000Z'",
      );
      yield* reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect({ saveCount, statusCount }).toEqual({ saveCount: 1, statusCount: 1 });
      expect(yield* outbox.hasRetryableWork).toBe(false);
      expect(
        database
          .prepare(
            `SELECT last_error, provider_document_id, provider_status, status
              FROM osfo_memory_provider_outbox
              ORDER BY sequence`,
          )
          .all(),
      ).toEqual([
        {
          last_error: "Conversation processing failed",
          provider_document_id: "document-1",
          provider_status: "failed",
          status: "failed",
        },
        {
          last_error: null,
          provider_document_id: null,
          provider_status: null,
          status: "pending",
        },
      ]);
    }),
  ),
);

it.effect("allows independent reconcilers to overlap without duplicating provider work", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const outbox = makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage)));
      yield* outbox.enqueueDeletion(
        authorizedDeletion("delete-user-1", "session-1", "user-1", past),
      );
      yield* outbox.enqueueDeletion(
        authorizedDeletion("delete-user-2", "session-2", "user-2", past),
      );
      const observed: Array<string> = [];
      let active = 0;
      let maximumActive = 0;
      const provider = providerStub({
        deleteSessionConversation: ({ userId }) =>
          Effect.gen(function* () {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            yield* Effect.yieldNow;
            observed.push(userId);
            active -= 1;
            return { _tag: "Deleted" as const };
          }),
      });

      yield* Effect.all(
        [
          reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions),
          reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(maximumActive).toBe(2);
      expect(observed).toHaveLength(2);
      expect(new Set(observed)).toEqual(new Set(["user-1", "user-2"]));
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM osfo_memory_provider_outbox WHERE status = 'completed'",
          )
          .get(),
      ).toEqual({ count: 2 });
    }),
  ),
);

it.effect("durably retains deletion work across a provider outage and store restart", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const db = makeAgentDb(asDurableObjectStorage(storage));
      const outbox = makeMemoryProviderOutboxStore(db);
      yield* outbox.enqueueDeletion(
        authorizedDeletion("delete-session-1", "session-1", "user-1", past),
      );
      const provider = providerStub({
        deleteSessionConversation: () =>
          Effect.fail(
            new MemoryProvider.MemoryProviderUnavailable({
              message: "Provider is unavailable",
              operation: "deleteSessionConversation",
            }),
          ),
      });

      yield* reconcileMemoryProviderOutbox(outbox, permittedDeletionOptions).pipe(
        Effect.provideService(MemoryProvider.Service, provider),
        Effect.provideService(Db.Service, unavailableDatabase),
        Effect.provide(BrowserCrypto.layer),
      );

      expect(
        database
          .prepare(
            `SELECT attempt_count, last_error, status
              FROM osfo_memory_provider_outbox
              WHERE outbox_id = ?`,
          )
          .get("delete-session-1"),
      ).toEqual({
        attempt_count: 1,
        last_error: "Provider is unavailable",
        status: "pending",
      });

      const restarted = makeMemoryProviderOutboxStore(db);
      const recovered = yield* restarted.claimNext(now, liveLease, "claim-after-restart");
      expect(Option.getOrThrow(recovered)).toMatchObject({
        attemptCount: 2,
        outboxId: "delete-session-1",
        payload: {
          _tag: "DeleteSessionConversation",
          sessionId: "session-1",
          userId: "user-1",
        },
      });
    }),
  ),
);

it.effect("rejects usage evidence without a matching provider-applied marker", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      seedSession(database);
      const db = makeAgentDb(asDurableObjectStorage(storage));
      yield* makeAgentStore(db).recordCommittedTurn(
        committedTurn("assistant-1", "request-1"),
        conversationProjection("assistant-1"),
      );
      database
        .prepare(
          `UPDATE osfo_memory_provider_outbox
            SET usage_json = ?
            WHERE outbox_id = ?`,
        )
        .run(
          '{"items":[],"rateCardVersion":"test-rate-card"}',
          "conversation:9:session-1:assistant-1",
        );

      const claimed = yield* makeMemoryProviderOutboxStore(db)
        .claimNext(now, liveLease, "claim-invalid")
        .pipe(Effect.result);

      expect(Result.isFailure(claimed)).toBe(true);
      if (Result.isFailure(claimed)) {
        expect(claimed.failure._tag).toBe("AgentStoreRecordInvalid");
      }
    }),
  ),
);

const withDatabase = <A, E>(
  use: (database: TestDatabase) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(Effect.sync(makeTestDatabase), use, ({ database }) =>
    Effect.sync(() => database.close()),
  );

const withEmptyDatabase = <A, E>(
  use: (database: TestDatabase) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(Effect.sync(makeEmptyTestDatabase), use, ({ database }) =>
    Effect.sync(() => database.close()),
  );

interface TestDatabase {
  readonly database: DatabaseSync;
  readonly storage: NodeSqliteStorage;
}

interface NodeSqliteStorage {
  readonly sql: Pick<SqlStorage, "exec">;
  readonly transactionSync: <A>(transaction: () => A) => A;
}

const makeTestDatabase = (): TestDatabase => {
  const { database, storage } = makeEmptyTestDatabase();
  const migrations = new URL("./migrations/", import.meta.url);
  const migrationFiles = readdirSync(migrations).filter((name) => name.endsWith(".sql"));
  // oxlint-disable-next-line unicorn/no-array-sort -- The Worker target lacks ES2023 toSorted; this local fresh array is safe to mutate.
  migrationFiles.sort();
  for (const filename of migrationFiles) {
    const sql = readFileSync(new URL(filename, migrations), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", "\n"));
  }
  return { database, storage };
};

const makeEmptyTestDatabase = (): TestDatabase => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return { database, storage: nodeSqliteStorage(database) };
};

const nodeSqliteStorage = (database: DatabaseSync): NodeSqliteStorage => ({
  sql: {
    exec: <T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: Array<SqlStorageValue>
    ): SqlStorageCursor<T> => {
      const statement = database.prepare(query);
      // SAFETY: normalizeRow maps node:sqlite's closed row union to the Cloudflare value union.
      const rows = statement.all(...bindings.map(toNodeBinding)).map(normalizeRow) as Array<T>;
      return new NodeSqlCursor(
        rows,
        statement.columns().map(({ name }) => name),
      );
    },
  },
  transactionSync: <A>(transaction: () => A): A => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = transaction();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  },
});

const asDurableObjectStorage = (storage: NodeSqliteStorage): DurableObjectStorage => {
  // SAFETY: The installed Durable SQLite driver reads only sql.exec and transactionSync; this
  // Node-only adapter implements both against one synchronous real SQLite connection.
  // oxlint-disable-next-line osfo/no-chained-type-assertions -- This compatibility proof is contained at the Node-only adapter boundary.
  return storage as unknown as DurableObjectStorage;
};

class NodeSqlCursor<T extends Record<string, SqlStorageValue>> implements SqlStorageCursor<T> {
  #index = 0;
  readonly #rows: Array<T>;
  readonly columnNames: Array<string>;
  readonly rowsRead: number;
  readonly rowsWritten = 0;

  constructor(rows: Array<T>, columnNames: Array<string>) {
    this.#rows = rows;
    this.columnNames = columnNames;
    this.rowsRead = this.#rows.length;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.#rows.values();
  }

  next(): { done?: false; value: T } | { done: true; value?: never } {
    const value = this.#rows[this.#index];
    if (value === undefined) return { done: true };
    this.#index += 1;
    return { done: false, value };
  }

  one(): T {
    const [only, ...remaining] = this.#rows;
    if (only === undefined || remaining.length > 0) {
      throw new Error("Expected exactly one SQLite row");
    }
    return only;
  }

  raw<U extends Array<SqlStorageValue>>(): IterableIterator<U> {
    // SAFETY: Each tuple follows columnNames order and contains only normalized SqlStorageValue values.
    return this.#rows.map((row) => this.columnNames.map((name) => row[name]) as U).values();
  }

  toArray(): Array<T> {
    return [...this.#rows];
  }
}

const normalizeRow = (row: Record<string, SQLOutputValue>): Record<string, SqlStorageValue> =>
  // SAFETY: Node SQLite row keys are column names, and normalizeValue maps its closed output union
  // to the Cloudflare Durable SQLite value union expected by Drizzle.
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));

const normalizeValue = (value: SQLOutputValue): SqlStorageValue =>
  value instanceof Uint8Array
    ? value.slice().buffer
    : typeof value === "bigint"
      ? Number(value)
      : value;

const toNodeBinding = (value: SqlStorageValue): SQLInputValue =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value;

const seedSession = (database: DatabaseSync) => {
  database
    .prepare("INSERT INTO osfo_conversation_routes (is_primary, route_id) VALUES (1, ?)")
    .run("route-1");
  database
    .prepare(
      `INSERT INTO osfo_session_ownership
        (became_current_at, ownership_sequence, replaced_at, route_id, session_id)
        VALUES (?, 1, NULL, ?, ?)`,
    )
    .run(now, "route-1", "session-1");
};

const committedTurn = (assistantMessageId: string, thinkRequestId: string) => ({
  assistantMessageId: AssistantMessageId.make(assistantMessageId),
  sessionId: SessionId.make("session-1"),
  source: "hook" as const,
  thinkRequestId: ThinkRequestId.make(thinkRequestId),
});

const conversationProjection = (assistantMessageId: string) =>
  ConversationSnapshotProjection.make({
    allowancePeriodId: AllowancePeriodId.make("allowance-1"),
    conversation: MemoryProvider.ConversationSnapshot.make({
      messages: [
        { content: "Remember this", role: "user" },
        { content: "I will remember it", role: "assistant" },
      ],
      usageStartIndex: 0,
    }),
    lastMessageId: AssistantMessageId.make(assistantMessageId),
    sessionId: SessionId.make("session-1"),
    userId: UserId.make("user-1"),
  });

const deletion = (outboxId: string, sessionId: string, userId = "user-1", enqueuedAt = now) =>
  authorizedDeletion(outboxId, sessionId, userId, enqueuedAt);

const sessionDeletionProgress = (documentId: string) => ({
  _tag: "DeleteSessionConversation" as const,
  awaitingDiscovery: false,
  targets: [
    {
      documentId: MemoryProvider.ProviderDocumentId.make(documentId),
      status: "observed" as const,
    },
  ],
});

const authorizedDeletion = (
  outboxId: string,
  sessionId: string,
  userId = "user-1",
  enqueuedAt = now,
) => {
  const user = UserId.make(userId);
  return {
    enqueuedAt,
    outboxId: MemoryProviderOutboxId.make(outboxId),
    payload: {
      _tag: "DeleteSessionConversation" as const,
      authorization: {
        actionId: ActionId.make(outboxId),
        authorityIdentity: {
          _tag: "AuthSession" as const,
          authSessionId: AuthSessionId.make(`auth-${userId}`),
          userId: user,
        },
        operation: "session.delete" as const,
        presentation: ApprovalPresentation.make(`Delete Session ${sessionId}`),
      },
      sessionId: SessionId.make(sessionId),
      userId: user,
    },
  };
};

const forgetKnowledgeDeletion = (outboxId: string) => {
  const userId = UserId.make("user-1");
  return {
    enqueuedAt: now,
    outboxId: MemoryProviderOutboxId.make(outboxId),
    payload: {
      _tag: "ForgetKnowledge" as const,
      authorization: {
        actionId: ActionId.make(outboxId),
        authorityIdentity: {
          _tag: "AuthSession" as const,
          authSessionId: AuthSessionId.make("auth-user-1"),
          userId,
        },
        operation: "memory.forgetKnowledge" as const,
        presentation: ApprovalPresentation.make("Forget memory-1 and memory-2"),
      },
      memoryIds: [
        MemoryProvider.KnowledgeMemoryId.make("memory-1"),
        MemoryProvider.KnowledgeMemoryId.make("memory-2"),
      ] as const,
      userId,
    },
  };
};

const permittedDeletionOptions = {
  authorizeDeletion: () => Effect.succeed({ _tag: "Permitted" as const }),
  prepareDeletion: () => Effect.void,
};

const providerStub = (overrides: Partial<MemoryProvider.Interface>): MemoryProvider.Interface => ({
  checkConversationSearchability: () => Effect.succeed(true),
  configureOrganizationGuidance: Effect.void,
  configureUserGuidance: () => Effect.void,
  deleteSessionConversation: () => Effect.die(new Error("Unexpected Session deletion")),
  deleteUserKnowledge: () => Effect.die(new Error("Unexpected User deletion")),
  findSessionConversation: () =>
    Effect.succeed({
      _tag: "Found",
      documentIds: [MemoryProvider.ProviderDocumentId.make("document-1")],
    }),
  forgetKnowledge: () => Effect.die(new Error("Unexpected forget")),
  getConversationStatus: () => Effect.die(new Error("Unexpected conversation status read")),
  recall: () => Effect.die(new Error("Unexpected recall")),
  saveConversation: () => Effect.die(new Error("Unexpected conversation save")),
  verifySessionConversation: () => Effect.succeed({ _tag: "Verified" }),
  ...overrides,
});

const conversationSaveResult = (
  documentId: string,
  processingStatus: MemoryProvider.ConversationProcessingStatus,
): MemoryProvider.SaveConversationResult => ({
  documentId: MemoryProvider.ProviderDocumentId.make(documentId),
  processingStatus,
  usage: {
    completedNonModelCost: [
      {
        activity: "conversationsAndMemory",
        ratedCostUsdMicros: 10n,
        resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
      },
    ],
  },
});

const unavailableDatabase: Db.Interface = {
  database: Effect.die(new Error("Unexpected PostgreSQL access")),
};

const failingUsageDatabase: Db.Interface = {
  database: Effect.succeed(
    // SAFETY: Allowance recording only calls transaction on this focused failure stub.
    {
      transaction: () => Promise.reject(new Error("Injected PostgreSQL outage")),
    } as unknown as Db.Database,
  ),
};

const thinkSqlProvider = (database: DatabaseSync): SqlProvider => ({
  sql: (strings, ...values) => {
    const query = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? "?" : ""),
      "",
    );
    const bindings = values.map((value) => (typeof value === "boolean" ? Number(value) : value));
    // SAFETY: Think's SqlProvider accepts the same closed SQLite values and returns rows whose
    // generic shape is selected by its own fixed queries.
    return database.prepare(query).all(...bindings) as never;
  },
});

const seedThinkHistory = (session: Session, prefix: string) =>
  Effect.promise(() =>
    session.appendMessage({
      id: `${prefix}-user`,
      parts: [{ text: `${prefix} question`, type: "text" }],
      role: "user",
    }),
  ).pipe(
    Effect.andThen(
      Effect.promise(() =>
        session.appendMessage(
          {
            id: `${prefix}-assistant`,
            parts: [{ text: `${prefix} answer`, type: "text" }],
            role: "assistant",
          },
          `${prefix}-user`,
        ),
      ),
    ),
    Effect.andThen(
      Effect.promise(() =>
        session.addCompaction(`${prefix} summary`, `${prefix}-user`, `${prefix}-assistant`),
      ),
    ),
  );

const thinkSessionCounts = (database: DatabaseSync, sessionId: string) => ({
  compactions: Number(
    database
      .prepare("SELECT COUNT(*) AS count FROM assistant_compactions WHERE session_id = ?")
      .get(sessionId)?.["count"] ?? 0,
  ),
  fts: Number(
    database
      .prepare("SELECT COUNT(*) AS count FROM assistant_fts WHERE session_id = ?")
      .get(sessionId)?.["count"] ?? 0,
  ),
  messages: Number(
    database
      .prepare("SELECT COUNT(*) AS count FROM assistant_messages WHERE session_id = ?")
      .get(sessionId)?.["count"] ?? 0,
  ),
});

const countRows = (
  database: DatabaseSync,
  table: "osfo_committed_turns" | "osfo_memory_provider_outbox",
): number => {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.["count"] ?? 0);
};
