import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  decodeInventoryRequest,
  decodeInventoryResponse,
  encodeInventoryResponse,
  requestIdentity,
  type InventoryResponse,
} from "@osfo/api/browser-host";
import { Clock, Effect, Option, Schema } from "effect";

const Stored = Schema.Struct({ response: Schema.NullOr(Schema.String), expires_at: Schema.Int });
const Count = Schema.Struct({ count: Schema.Int });
const Binding = Schema.Struct({ owner: Schema.String, session: Schema.String });

export interface Options {
  readonly databasePath: string;
  readonly hostSessionId: string;
  readonly ownerUserId: string;
  readonly token: string;
}

/** One persistent binding and request ledger belong to one provisioned browser host. */
export const make = (options: Options, inspect: Effect.Effect<InventoryResponse["outcome"]>) => {
  const database = new DatabaseSync(options.databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, session TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (identity TEXT PRIMARY KEY, response TEXT, expires_at INTEGER NOT NULL);
  `);
  database
    .prepare("INSERT OR IGNORE INTO binding VALUES (1, ?, ?)")
    .run(options.ownerUserId, options.hostSessionId);
  const binding = Schema.decodeUnknownSync(Binding)(
    database.prepare("SELECT owner, session FROM binding WHERE id = 1").get(),
  );
  if (binding.owner !== options.ownerUserId || binding.session !== options.hostSessionId) {
    database.close();
    throw new Error("Browser host database belongs to another owner or session");
  }
  let busy = false;
  return {
    close: () => {
      if (database.isOpen) database.close();
    },
    handle: Effect.fn("BrowserHost.handle")(function* (
      authorization: string | undefined,
      body: string,
    ) {
      const supplied = Buffer.from(authorization ?? "");
      const expected = Buffer.from(`Bearer ${options.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return { status: 401, body: "" };
      const request = decodeInventoryRequest(body);
      if (request === undefined) return { status: 400, body: "" };
      if (
        request.ownerUserId !== options.ownerUserId ||
        request.hostSessionId !== options.hostSessionId
      )
        return { status: 403, body: "" };
      const identity = requestIdentity(request);
      const now = yield* Clock.currentTimeMillis;
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
        return reply(response ?? { request, outcome: { _tag: "Unknown" } });
      }
      const count = yield* Schema.decodeUnknownEffect(Count)(
        database.prepare("SELECT count(*) AS count FROM requests").get(),
      );
      if (busy || count.count >= 1024) return reply({ request, outcome: { _tag: "Unavailable" } });
      const claimed = database
        .prepare("INSERT OR IGNORE INTO requests VALUES (?, NULL, ?)")
        .run(identity, now + 60_000);
      if (claimed.changes !== 1) return reply({ request, outcome: { _tag: "Unknown" } });
      busy = true;
      const outcome = yield* inspect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            busy = false;
          }),
        ),
      );
      const response = { request, outcome };
      database
        .prepare("UPDATE requests SET response = ? WHERE identity = ?")
        .run(encodeInventoryResponse(response), identity);
      return reply(response);
    }),
  };
};

const reply = (response: InventoryResponse) => ({
  status: 200,
  body: encodeInventoryResponse(response),
});

export * as Host from "./host.ts";
