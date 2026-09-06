/* oxlint-disable eslint/no-underscore-dangle -- Browser wire outcomes use the canonical _tag discriminator. */
import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  decodeInventoryRequest,
  decodeBrowserRequest,
  decodeInventoryResponse,
  encodeInventoryResponse,
  encodeBrowserResponse,
  requestIdentity,
  type InventoryResponse,
} from "@osfo/api/browser-host";
import { Clock, Data, Effect, Option, Schema } from "effect";

import { BrowserTask } from "./browser-task.ts";

const Stored = Schema.Struct({ response: Schema.NullOr(Schema.String), expires_at: Schema.Int });
const Count = Schema.Struct({ count: Schema.Int });
const Binding = Schema.Struct({ owner: Schema.String, session: Schema.String });

export interface Options {
  readonly databasePath: string;
  readonly hostSessionId: string;
  readonly ownerUserId: string;
  readonly token: string;
}

/** SQLite could not initialize or retain the host request ledger. */
export class StorageUnavailable extends Data.TaggedError("BrowserHostStorageUnavailable")<{
  readonly cause: unknown;
}> {}

/** One scoped binding and request ledger belong to one provisioned browser host. */
export const make = Effect.fn("BrowserHost.make")(function* (
  options: Options,
  inspect: Effect.Effect<InventoryResponse["outcome"]>,
  browser?: {
    readonly runtime: BrowserTask.Runtime;
    readonly allowedOrigins: ReadonlyArray<string>;
  },
) {
  const database = yield* Effect.acquireRelease(
    storage(() => new DatabaseSync(options.databasePath)),
    (resource) => storage(() => resource.close()).pipe(Effect.orDie),
  );
  yield* storage(() => {
    database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, session TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (identity TEXT PRIMARY KEY, response TEXT, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS revocations (id INTEGER PRIMARY KEY CHECK (id = 1));
  `);
    database
      .prepare("INSERT OR IGNORE INTO binding VALUES (1, ?, ?)")
      .run(options.ownerUserId, options.hostSessionId);
    const binding = Schema.decodeUnknownSync(Binding)(
      database.prepare("SELECT owner, session FROM binding WHERE id = 1").get(),
    );
    if (binding.owner !== options.ownerUserId || binding.session !== options.hostSessionId) {
      throw new Error("Browser host database belongs to another owner or session");
    }
  });
  let busy = false;
  const executeBrowser =
    browser === undefined
      ? undefined
      : yield* storage(() => BrowserTask.make(database, browser.runtime, browser.allowedOrigins));
  const authenticated = (authorization: string | undefined) => {
    const supplied = Buffer.from(authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const handlers = {
    handleBrowser: Effect.fn("BrowserHost.handleBrowser")(function* (
      authorization: string | undefined,
      body: string,
    ) {
      if (!authenticated(authorization)) return { status: 401, body: "" };
      const request = decodeBrowserRequest(body);
      if (request === undefined) return { status: 400, body: "" };
      if (
        request.ownerUserId !== options.ownerUserId ||
        request.hostSessionId !== options.hostSessionId
      )
        return { status: 403, body: "" };
      if (executeBrowser === undefined) return { status: 503, body: "" };
      if (request.command._tag === "Revoke") {
        yield* storage(() =>
          database.prepare("INSERT OR IGNORE INTO revocations VALUES (1)").run(),
        );
        const closed = busy ? false : yield* executeBrowser.revoke;
        if (closed) yield* storage(() => database.exec("DELETE FROM requests;"));
        return {
          status: 200,
          body: encodeBrowserResponse({
            request,
            outcome: closed ? { _tag: "Closed" } : { _tag: "Unknown" },
          }),
        };
      }
      const revoked = yield* storage(
        () => database.prepare("SELECT id FROM revocations WHERE id = 1").get() !== undefined,
      );
      if (revoked) return { status: 403, body: "" };
      const outcome = yield* executeBrowser.execute(request);
      return { status: 200, body: encodeBrowserResponse({ request, outcome }) };
    }),
    handle: Effect.fn("BrowserHost.handle")(function* (
      authorization: string | undefined,
      body: string,
    ) {
      if (!authenticated(authorization)) return { status: 401, body: "" };
      const revoked = yield* storage(
        () => database.prepare("SELECT id FROM revocations WHERE id = 1").get() !== undefined,
      );
      if (revoked) return { status: 403, body: "" };
      const request = decodeInventoryRequest(body);
      if (request === undefined) return { status: 400, body: "" };
      if (
        request.ownerUserId !== options.ownerUserId ||
        request.hostSessionId !== options.hostSessionId
      )
        return { status: 403, body: "" };
      const identity = requestIdentity(request);
      const now = yield* Clock.currentTimeMillis;
      return yield* Effect.acquireUseRelease(
        storage(() => {
          // Expire result bodies, never the identities that prevent a second dispatch.
          database.prepare("UPDATE requests SET response = NULL WHERE expires_at <= ?").run(now);
          const stored = Schema.decodeUnknownOption(Stored)(
            database
              .prepare("SELECT response, expires_at FROM requests WHERE identity = ?")
              .get(identity),
          );
          if (Option.isSome(stored)) {
            const response =
              stored.value.response === null
                ? undefined
                : decodeInventoryResponse(stored.value.response);
            return response ?? { request, outcome: { _tag: "Unknown" as const } };
          }
          const count = Schema.decodeUnknownSync(Count)(
            database.prepare("SELECT count(*) AS count FROM requests").get(),
          );
          if (busy || count.count >= 1024)
            return { request, outcome: { _tag: "Unavailable" as const } };
          const claimed = database
            .prepare("INSERT OR IGNORE INTO requests VALUES (?, NULL, ?)")
            .run(identity, now + 60_000);
          if (claimed.changes !== 1) return { request, outcome: { _tag: "Unknown" as const } };
          busy = true;
          return undefined;
        }),
        (existing) =>
          existing !== undefined
            ? Effect.succeed(reply(existing))
            : Effect.gen(function* () {
                const outcome = yield* inspect;
                const response = { request, outcome };
                yield* storage(() =>
                  database
                    .prepare("UPDATE requests SET response = ? WHERE identity = ?")
                    .run(encodeInventoryResponse(response), identity),
                );
                return reply(response);
              }),
        (existing) =>
          Effect.sync(() => {
            if (existing === undefined) busy = false;
          }),
      );
    }),
  };
  let readingRequest = false;
  return {
    ...handlers,
    handleRequest: Effect.fn("BrowserHost.handleRequest")(function* <E>(
      route: "inventory" | "browser",
      authorization: string | undefined,
      readBody: Effect.Effect<string, E>,
    ) {
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          if (!authenticated(authorization)) return { status: 401, body: "" };
          if (readingRequest) return { status: 503, body: "" };
          readingRequest = true;
          return undefined;
        }),
        (refused) =>
          refused !== undefined
            ? Effect.succeed(refused)
            : readBody.pipe(
                Effect.flatMap((body) =>
                  route === "inventory"
                    ? handlers.handle(authorization, body)
                    : handlers.handleBrowser(authorization, body),
                ),
              ),
        (refused) =>
          Effect.sync(() => {
            if (refused === undefined) readingRequest = false;
          }),
      );
    }),
  };
});

const storage = <A>(operation: () => A) =>
  Effect.try({ try: operation, catch: (cause) => new StorageUnavailable({ cause }) });

const reply = (response: InventoryResponse) => ({
  status: 200,
  body: encodeInventoryResponse(response),
});

export * as Host from "./host.ts";
