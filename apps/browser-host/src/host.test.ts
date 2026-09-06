/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json -- Real Node filesystem fixtures and deliberate malformed wire payloads test the transport boundary. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { decodeInventoryResponse } from "@osfo/api/browser-host";
import { Effect } from "effect";
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
  Effect.acquireRelease(
    Effect.sync(() =>
      Host.make(
        {
          databasePath: join(path, "host.sqlite"),
          ownerUserId: request.ownerUserId,
          hostSessionId: request.hostSessionId,
          token,
        },
        inspect,
      ),
    ),
    (host) => Effect.sync(host.close),
  );

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
      const first = yield* open(path, inspect);
      yield* Effect.exit(first.handle(`Bearer ${token}`, JSON.stringify(request)));
      first.close();
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
      const host = yield* open(path, Effect.succeed({ _tag: "Unknown" }));
      host.close();
      expect(() =>
        Host.make(
          {
            databasePath: join(path, "host.sqlite"),
            ownerUserId: "owner-two",
            hostSessionId: request.hostSessionId,
            token,
          },
          Effect.succeed({ _tag: "Unknown" }),
        ),
      ).toThrow("another owner or session");
    }),
  );
});
