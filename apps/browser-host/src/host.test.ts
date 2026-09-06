/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json -- Real Node filesystem fixtures and deliberate malformed wire payloads test the transport boundary. */
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { decodeInventoryResponse } from "@osfo/api/browser-host";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { Host } from "./host.ts";

const token = "test-token-kept-only-in-this-test";
const request = {
  hostSessionId: "instance-one",
  operation: "inventory",
  operationId: "call-one",
  ownerUserId: "owner-one",
  turnId: "turn-one",
};

const directory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "osfo-browser-host-"))),
  (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
);
const open = (path: string, inspect: Effect.Effect<{ readonly _tag: "Unknown" }>) =>
  Host.make(
    {
      databasePath: join(path, "host.sqlite"),
      ownerUserId: request.ownerUserId,
      hostSessionId: request.hostSessionId,
      token,
    },
    inspect,
  );

afterEach(() => vi.restoreAllMocks());

describe("browser host admission and replay", () => {
  it.effect(
    "rejects missing credentials, another owner/session, and arbitrary code without dispatch",
    () =>
      Effect.gen(function* () {
        const path = yield* directory;
        const host = yield* open(path, Effect.die(new Error("unexpected CUA call")));
        expect((yield* host.handle(undefined, JSON.stringify(request))).status).toBe(401);
        expect(
          (yield* host.handle(
            `Bearer ${token}`,
            JSON.stringify({ ...request, ownerUserId: "owner-two" }),
          )).status,
        ).toBe(403);
        expect(
          (yield* host.handle(
            `Bearer ${token}`,
            JSON.stringify({ ...request, hostSessionId: "instance-two" }),
          )).status,
        ).toBe(403);
        expect(
          (yield* host.handle(
            `Bearer ${token}`,
            JSON.stringify({ ...request, code: "await cua.createBrowserTab()" }),
          )).status,
        ).toBe(400);
      }),
  );

  it.effect("retains ambiguous claims across restart and expiry without dispatching again", () =>
    Effect.gen(function* () {
      const path = yield* directory;
      let calls = 0;
      const inspect = Effect.sync(() => {
        calls += 1;
      }).pipe(Effect.andThen(Effect.die(new Error("simulated disconnect after dispatch"))));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* open(path, inspect);
          yield* Effect.exit(first.handle(`Bearer ${token}`, JSON.stringify(request)));
        }),
      );
      yield* TestClock.adjust("61 seconds");
      const second = yield* open(path, inspect);
      const repeated = yield* second.handle(`Bearer ${token}`, JSON.stringify(request));
      expect(decodeInventoryResponse(repeated.body)?.outcome).toEqual({ _tag: "Unknown" });
      expect(calls).toBe(1);
    }),
  );

  it.effect("cannot reassign a persisted browser session to another owner", () =>
    Effect.gen(function* () {
      const path = yield* directory;
      yield* Effect.scoped(open(path, Effect.succeed({ _tag: "Unknown" })));
      const rejected = yield* Effect.result(
        Effect.scoped(
          Host.make(
            {
              databasePath: join(path, "host.sqlite"),
              ownerUserId: "owner-two",
              hostSessionId: request.hostSessionId,
              token,
            },
            Effect.succeed({ _tag: "Unknown" }),
          ),
        ),
      );
      expect(rejected).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "BrowserHostStorageUnavailable",
          cause: expect.objectContaining({
            message: expect.stringContaining("another owner or session"),
          }),
        },
      });
    }),
  );
  it.effect("closes the acquired database when initialization fails", () =>
    Effect.gen(function* () {
      const path = yield* directory;
      const fixture = new DatabaseSync(join(path, "host.sqlite"));
      fixture.exec("CREATE TABLE binding (id INTEGER PRIMARY KEY)");
      fixture.close();
      const close = vi.spyOn(DatabaseSync.prototype, "close");
      const result = yield* Effect.result(
        Effect.scoped(open(path, Effect.die(new Error("unexpected dispatch")))),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserHostStorageUnavailable" },
      });
      expect(close).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("returns a typed storage failure before dispatch when SQLite is locked", () =>
    Effect.gen(function* () {
      const path = yield* directory;
      let calls = 0;
      const host = yield* open(
        path,
        Effect.sync(() => {
          calls += 1;
          return { _tag: "Unknown" } as const;
        }),
      );
      const lock = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(join(path, "host.sqlite"))),
        (database) => Effect.sync(() => database.close()),
      );
      lock.exec("BEGIN IMMEDIATE");
      const failed = yield* Effect.result(host.handle(`Bearer ${token}`, JSON.stringify(request)));
      expect(failed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserHostStorageUnavailable" },
      });
      expect(calls).toBe(0);
      lock.exec("ROLLBACK");
      const accepted = yield* host.handle(`Bearer ${token}`, JSON.stringify(request));
      expect(accepted.status).toBe(200);
      expect(calls).toBe(1);
    }),
  );

  it.effect("retains a claim when storing the dispatched result fails", () =>
    Effect.gen(function* () {
      const path = yield* directory;
      let calls = 0;
      const inspect = Effect.sync(() => {
        calls += 1;
        return { _tag: "Unknown" } as const;
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* open(path, inspect);
          const fixture = new DatabaseSync(join(path, "host.sqlite"));
          fixture.exec(
            "CREATE TRIGGER fail_result BEFORE UPDATE OF response ON requests WHEN NEW.response IS NOT NULL BEGIN SELECT RAISE(FAIL, 'result storage failed'); END",
          );
          fixture.close();
          const failed = yield* Effect.result(
            host.handle(`Bearer ${token}`, JSON.stringify(request)),
          );
          expect(failed).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "BrowserHostStorageUnavailable" },
          });
        }),
      );
      const restarted = yield* open(path, inspect);
      const replay = yield* restarted.handle(`Bearer ${token}`, JSON.stringify(request));
      expect(decodeInventoryResponse(replay.body)?.outcome).toEqual({ _tag: "Unknown" });
      expect(calls).toBe(1);
    }),
  );
  it.effect("releases the busy host after interruption without replaying the claimed request", () =>
    Effect.gen(function* () {
      const path = yield* directory;
      const started = yield* Deferred.make<void>();
      let calls = 0;
      const host = yield* open(
        path,
        Effect.gen(function* () {
          calls += 1;
          if (calls === 1) {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }
          return { _tag: "Unknown" } as const;
        }),
      );
      const first = yield* Effect.forkScoped(
        host.handle(`Bearer ${token}`, JSON.stringify(request)),
      );
      yield* Deferred.await(started);
      const next = JSON.stringify({ ...request, operationId: "call-two" });
      const busy = yield* host.handle(`Bearer ${token}`, next);
      expect(decodeInventoryResponse(busy.body)?.outcome).toEqual({ _tag: "Unavailable" });
      yield* Fiber.interrupt(first);
      const replay = yield* host.handle(`Bearer ${token}`, JSON.stringify(request));
      expect(decodeInventoryResponse(replay.body)?.outcome).toEqual({ _tag: "Unknown" });
      yield* host.handle(`Bearer ${token}`, next);
      expect(calls).toBe(2);
    }),
  );
});
