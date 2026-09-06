/* oxlint-disable eslint/no-underscore-dangle -- Browser wire outcomes use the canonical _tag discriminator. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  browserRequestIdentity,
  decodeBrowserResponse,
  encodeBrowserRequest,
  encodeBrowserResponse,
  type BrowserInteraction,
  type BrowserOutcome,
  type BrowserRequest,
} from "@osfo/api/browser-host";
import { Clock, Data, Effect, Option, Schema } from "effect";

const Page = Schema.Struct({ url: Schema.String, text: Schema.String });
export type Page = typeof Page.Type;

export interface Runtime {
  readonly closeAll: Effect.Effect<boolean>;
  /** Unavailable proves no create was dispatched; every uncertain create returns Unknown. */
  readonly open: (
    url: string,
  ) => Effect.Effect<
    | { readonly _tag: "Opened"; readonly tabId: string; readonly page: Page }
    | { readonly _tag: "Unknown" | "Unavailable" }
  >;
  readonly observe: (
    tabId: string,
    origin: string,
  ) => Effect.Effect<
    | { readonly _tag: "Page"; readonly page: Page }
    | { readonly _tag: "HumanRequired" | "Unknown" | "Unavailable" }
  >;
  readonly interact: (
    tabId: string,
    origin: string,
    expected: Page,
    interaction: BrowserInteraction,
  ) => Effect.Effect<
    | { readonly _tag: "Page"; readonly page: Page }
    | { readonly _tag: "HumanRequired" | "Unknown" | "Unavailable" | "Stale" }
  >;
  readonly close: (tabId: string) => Effect.Effect<boolean>;
}

const Task = Schema.Struct({
  origin: Schema.String,
  tab_id: Schema.NullOr(Schema.String),
  observation_id: Schema.NullOr(Schema.String),
  page: Schema.NullOr(Schema.String),
  expires_at: Schema.Int,
  closed: Schema.Int,
});
const Operation = Schema.Struct({ digest: Schema.String, response: Schema.NullOr(Schema.String) });
const Count = Schema.Struct({ count: Schema.Int });
const encodePage = Schema.encodeSync(Schema.fromJsonString(Page));
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
class StorageUnavailable extends Data.TaggedError("BrowserTaskStorageUnavailable")<{
  readonly cause: unknown;
}> {}
const storage = <A>(operation: () => A) =>
  Effect.try({ try: operation, catch: (cause) => new StorageUnavailable({ cause }) });

/** One owned tab and a durable no-retry ledger for each bounded browser task. */
export const make = (
  database: DatabaseSync,
  runtime: Runtime,
  allowedOrigins: ReadonlyArray<string>,
) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS browser_tasks (
      identity TEXT PRIMARY KEY, origin TEXT NOT NULL, tab_id TEXT,
      observation_id TEXT, page TEXT, expires_at INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS browser_operations (
      identity TEXT PRIMARY KEY, task_identity TEXT NOT NULL, digest TEXT NOT NULL, response TEXT
    );
  `);
  let busy = false;
  const execute = Effect.fn("BrowserTask.executeClaimed")(function* (request: BrowserRequest) {
    const taskIdentity = encodeIdentity([
      request.ownerUserId,
      request.hostSessionId,
      request.taskId,
    ]);
    const identity = browserRequestIdentity(request);
    const digest = createHash("sha256").update(encodeBrowserRequest(request)).digest("hex");
    const readOperation = (key: string) =>
      storage(() =>
        Schema.decodeUnknownOption(Operation)(
          database
            .prepare("SELECT digest, response FROM browser_operations WHERE identity = ?")
            .get(key),
        ),
      );
    const stored = yield* readOperation(identity);
    if (Option.isSome(stored)) {
      if (stored.value.digest !== digest) return { _tag: "Conflict" } as const;
      return stored.value.response === null
        ? ({ _tag: "Unknown" } as const)
        : (decodeBrowserResponse(stored.value.response)?.outcome ?? ({ _tag: "Unknown" } as const));
    }
    if (request.command._tag === "Outcome") {
      const previous = yield* readOperation(
        browserRequestIdentity({ ...request, operationId: request.command.operationId }),
      );
      return Option.isSome(previous) && previous.value.response !== null
        ? (decodeBrowserResponse(previous.value.response)?.outcome ??
            ({ _tag: "Unknown" } as const))
        : ({ _tag: "Unknown" } as const);
    }
    const count = yield* storage(() =>
      Schema.decodeUnknownSync(Count)(
        database.prepare("SELECT count(*) AS count FROM browser_operations").get(),
      ),
    );
    if (count.count >= 1024) return { _tag: "Unavailable" } as const;
    const claimed = yield* storage(() =>
      database
        .prepare("INSERT OR IGNORE INTO browser_operations VALUES (?, ?, ?, NULL)")
        .run(identity, taskIdentity, digest),
    );
    if (claimed.changes !== 1) return { _tag: "Unknown" } as const;
    const outcome = yield* Effect.gen(function* (): Effect.fn.Return<
      BrowserOutcome,
      StorageUnavailable
    > {
      const now = yield* Clock.currentTimeMillis;
      const task = yield* storage(() =>
        Schema.decodeUnknownOption(Task)(
          database
            .prepare(
              "SELECT origin, tab_id, observation_id, page, expires_at, closed FROM browser_tasks WHERE identity = ?",
            )
            .get(taskIdentity),
        ),
      );
      const command = request.command;
      if (command._tag === "Open") {
        if (Option.isSome(task)) return { _tag: "Conflict" };
        if (!URL.canParse(command.url)) return { _tag: "Unavailable" };
        const url = new URL(command.url);
        if (!allowedOrigins.includes(url.origin) || url.username !== "" || url.password !== "")
          return { _tag: "Unavailable" };
        const active = yield* storage(() =>
          Schema.decodeUnknownSync(Count)(
            database.prepare("SELECT count(*) AS count FROM browser_tasks WHERE closed = 0").get(),
          ),
        );
        if (active.count >= 4) return { _tag: "Unavailable" };
        yield* storage(() =>
          database
            .prepare("INSERT INTO browser_tasks (identity, origin, expires_at) VALUES (?, ?, ?)")
            .run(taskIdentity, url.origin, now + 3_600_000),
        );
        const opened = yield* runtime.open(url.href);
        if (opened._tag === "Unavailable") {
          // The runtime's Open Unavailable outcome proves no create was dispatched.
          yield* storage(() =>
            database.prepare("DELETE FROM browser_tasks WHERE identity = ?").run(taskIdentity),
          );
          return opened;
        }
        if (opened._tag !== "Opened") return opened;
        yield* storage(() =>
          database
            .prepare("UPDATE browser_tasks SET tab_id = ? WHERE identity = ?")
            .run(opened.tabId, taskIdentity),
        );
        return yield* storage(() => retain(opened.page, request, taskIdentity, now));
      }
      if (Option.isNone(task) || task.value.tab_id === null) return { _tag: "Unavailable" };
      if (command._tag === "Close") {
        yield* storage(() =>
          database
            .prepare("UPDATE browser_tasks SET closed = 1 WHERE identity = ?")
            .run(taskIdentity),
        );
        const closed = yield* runtime.close(task.value.tab_id);
        if (!closed) return { _tag: "Unknown" };
        yield* storage(() =>
          database
            .prepare(
              "UPDATE browser_tasks SET page = NULL, observation_id = NULL WHERE identity = ?",
            )
            .run(taskIdentity),
        );
        return { _tag: "Closed" };
      }
      if (task.value.closed !== 0 || task.value.expires_at <= now) return { _tag: "Unavailable" };
      if (command._tag === "Observe") {
        const observed = yield* runtime.observe(task.value.tab_id, task.value.origin);
        return observed._tag === "Page"
          ? yield* storage(() => retain(observed.page, request, taskIdentity, now))
          : observed;
      }
      if (command._tag === "Interact") {
        if (task.value.observation_id !== command.observationId || task.value.page === null)
          return { _tag: "Stale" };
        const expected = Schema.decodeOption(Schema.fromJsonString(Page))(task.value.page);
        if (Option.isNone(expected)) return { _tag: "Unknown" };
        const result = yield* runtime.interact(
          task.value.tab_id,
          task.value.origin,
          expected.value,
          command.interaction,
        );
        return result._tag === "Page"
          ? yield* storage(() => retain(result.page, request, taskIdentity, now))
          : result;
      }
      return { _tag: "Unknown" };
    });
    yield* storage(() =>
      database
        .prepare("UPDATE browser_operations SET response = ? WHERE identity = ?")
        .run(encodeBrowserResponse({ request, outcome }), identity),
    );
    return outcome;
  });

  const revoke = Effect.fn("BrowserTask.revoke")(function* () {
    if (!(yield* runtime.closeAll)) return false;
    // A missing tab ID may mean create succeeded before its response was retained.
    // A restarted runtime's empty handle map cannot discharge that cleanup obligation.
    const unresolved = yield* storage(() =>
      database.prepare("SELECT identity FROM browser_tasks WHERE tab_id IS NULL LIMIT 1").get(),
    );
    if (unresolved !== undefined) return false;
    const tabs = yield* storage(() =>
      Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ tab_id: Schema.String })))(
        database.prepare("SELECT tab_id FROM browser_tasks WHERE tab_id IS NOT NULL").all(),
      ),
    );
    const closed = yield* Effect.forEach(tabs, (tab) => runtime.close(tab.tab_id), {
      concurrency: 1,
    });
    if (closed.some((value) => !value)) return false;
    yield* storage(() =>
      database.exec("DELETE FROM browser_operations; DELETE FROM browser_tasks;"),
    );
    return true;
  });
  const acquire = Effect.sync(() => {
    if (busy) return false;
    busy = true;
    return true;
  });
  const release = (acquired: boolean) =>
    Effect.sync(() => {
      if (acquired) busy = false;
    });
  return {
    execute: (request: BrowserRequest) =>
      Effect.acquireUseRelease(
        acquire,
        (acquired) =>
          acquired ? execute(request) : Effect.succeed({ _tag: "Unavailable" } as const),
        release,
      ),
    revoke: Effect.acquireUseRelease(
      acquire,
      (acquired) => (acquired ? revoke() : Effect.succeed(false)),
      release,
    ),
  };

  function retain(
    page: Page,
    request: BrowserRequest,
    taskIdentity: string,
    observedAt: number,
  ): BrowserOutcome {
    const observation = {
      observationId: request.operationId,
      taskId: request.taskId,
      observedAt,
      url: page.url,
      text: page.text,
    };
    database
      .prepare("UPDATE browser_tasks SET page = ?, observation_id = ? WHERE identity = ?")
      .run(encodePage(page), observation.observationId, taskIdentity);
    return { _tag: "Observed", observation };
  }
};

export * as BrowserTask from "./browser-task.ts";
