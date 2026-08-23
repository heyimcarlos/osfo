/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/node-builtin-import -- This Node-only suite supplies real SQLite persistence to the Durable SQLite adapter. */
/* oxlint-disable osfo/no-runtime-typeof -- The adapter branches over node:sqlite's closed SQLOutputValue union. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- The test adapter proves Cloudflare's generic cursor result shapes at its boundary. */
/* oxlint-disable typescript/no-unnecessary-type-parameters -- SqlStorageCursor.raw requires its upstream generic method signature. */
/* oxlint-disable eslint/no-underscore-dangle -- Effect payload assertions use the canonical _tag discriminator. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layers. */
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

import { expect, it } from "@effect/vitest";
import { BrowserCrypto } from "@effect/platform-browser";
import { Effect, Option, Result } from "effect";

import { Db, DbTimestamp } from "../../../db";
import {
  AllowancePeriodId,
  AssistantMessageId,
  SessionId,
  ThinkRequestId,
  UserId,
} from "../../../domain";
import { makeAgentDb } from "./client";
import { makeMemoryProviderOutboxStore, MemoryProviderOutboxId } from "./memory-provider-outbox";
import { makeAgentStore } from "./store";
import { ConversationDeltaProjection } from "../memory-provider-projection";
import { MemoryProvider } from "../../../services/memory-provider";
import { reconcileMemoryProviderOutbox } from "../memory-provider-reconciliation";

/**
 * These tests need white-box access because atomic SQLite rollback, unique claims, and stale lease
 * settlement cannot be observed through the public Worker without a forbidden test-only DO route.
 */

const now = DbTimestamp.make("2026-08-23T12:00:00.000Z");
const past = DbTimestamp.make("1960-01-01T00:00:00.000Z");
const liveLease = DbTimestamp.make("2026-08-23T12:01:00.000Z");
const extendedLease = DbTimestamp.make("2026-08-23T12:02:00.000Z");

it.effect("atomically records a committed turn and its provider delta", () =>
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
        payload_json: JSON.stringify({ _tag: "AppendConversationDelta", projection }),
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

it.effect("orders User deletion behind earlier Session append work", () =>
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
      expect(Option.getOrThrow(first).payload._tag).toBe("AppendConversationDelta");
      expect(yield* outbox.claimNext(now, liveLease, "claim-blocked-delete")).toEqual(
        Option.none(),
      );

      yield* outbox.complete(Option.getOrThrow(first), now);
      const deletion = yield* outbox.claimNext(now, liveLease, "claim-delete");
      expect(Option.getOrThrow(deletion).payload._tag).toBe("DeleteUserKnowledge");
    }),
  ),
);

it.effect("allows independent reconcilers to overlap without duplicating provider work", () =>
  withDatabase(({ database, storage }) =>
    Effect.gen(function* () {
      const outbox = makeMemoryProviderOutboxStore(makeAgentDb(asDurableObjectStorage(storage)));
      yield* outbox.enqueueDeletion(deletion("delete-user-1", "session-1", "user-1", past));
      yield* outbox.enqueueDeletion(deletion("delete-user-2", "session-2", "user-2", past));
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
        [reconcileMemoryProviderOutbox(outbox), reconcileMemoryProviderOutbox(outbox)],
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
      yield* outbox.enqueueDeletion(deletion("delete-session-1", "session-1", "user-1", past));
      const provider = providerStub({
        deleteSessionConversation: () =>
          Effect.fail(
            new MemoryProvider.MemoryProviderUnavailable({
              message: "Provider is unavailable",
              operation: "deleteSessionConversation",
            }),
          ),
      });

      yield* reconcileMemoryProviderOutbox(outbox).pipe(
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

const withDatabase = <A, E>(
  use: (database: TestDatabase) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(Effect.sync(makeTestDatabase), use, ({ database }) =>
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
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("./migrations/", import.meta.url);
  const migrationFiles = readdirSync(migrations).filter((name) => name.endsWith(".sql"));
  // oxlint-disable-next-line unicorn/no-array-sort -- The Worker target lacks ES2023 toSorted; this local fresh array is safe to mutate.
  migrationFiles.sort();
  for (const filename of migrationFiles) {
    const sql = readFileSync(new URL(filename, migrations), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", "\n"));
  }
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
  ConversationDeltaProjection.make({
    allowancePeriodId: AllowancePeriodId.make("allowance-1"),
    firstMessageId: "user-1",
    lastMessageId: AssistantMessageId.make(assistantMessageId),
    messages: [
      { content: "Remember this", role: "user" },
      { content: "I will remember it", role: "assistant" },
    ],
    sessionId: SessionId.make("session-1"),
    userId: UserId.make("user-1"),
  });

const deletion = (outboxId: string, sessionId: string, userId = "user-1", enqueuedAt = now) => ({
  enqueuedAt,
  outboxId: MemoryProviderOutboxId.make(outboxId),
  payload: {
    _tag: "DeleteSessionConversation" as const,
    sessionId: SessionId.make(sessionId),
    userId: UserId.make(userId),
  },
});

const providerStub = (overrides: Partial<MemoryProvider.Interface>): MemoryProvider.Interface => ({
  appendConversationDelta: () => Effect.die(new Error("Unexpected append")),
  deleteSessionConversation: () => Effect.die(new Error("Unexpected Session deletion")),
  deleteUserKnowledge: () => Effect.die(new Error("Unexpected User deletion")),
  forgetKnowledge: () => Effect.die(new Error("Unexpected forget")),
  recall: () => Effect.die(new Error("Unexpected recall")),
  ...overrides,
});

const unavailableDatabase: Db.Interface = {
  database: Effect.die(new Error("Unexpected PostgreSQL access")),
};

const countRows = (
  database: DatabaseSync,
  table: "osfo_committed_turns" | "osfo_memory_provider_outbox",
): number => {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.["count"] ?? 0);
};
