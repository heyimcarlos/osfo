/* oxlint-disable eslint/no-underscore-dangle -- Browser wire outcomes use the canonical _tag discriminator. */
/* oxlint-disable effecttsgo/node-builtin-import -- The real Executor bridge launches an isolated synthetic protocol fixture. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { vi } from "vitest";

import { BrowserRuntime } from "./browser-runtime.ts";

it.effect(
  "executes fixed programs in the bound Chrome tab and checks fresh page evidence before interacting",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "osfo-browser-runtime-"))),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
      );
      const runtime = yield* BrowserRuntime.make({
        codexCommand: fileURLToPath(
          new URL("../test-fixtures/codex-browser-task.mjs", import.meta.url),
        ),
        codexHome: directory,
        hostSessionId: "owned-instance",
      });
      const opened = yield* runtime.open("https://portal.example.test/appointments");
      expect(opened._tag).toBe("Opened");
      if (opened._tag !== "Opened") return;
      const changed = yield* runtime.interact(
        opened.tabId,
        "https://portal.example.test",
        opened.page,
        { _tag: "Click", target: "1" },
      );
      expect(changed).toMatchObject({
        _tag: "Page",
        page: { text: expect.stringContaining("SYNTHETIC-1") },
      });
      expect(
        yield* runtime.interact(opened.tabId, "https://portal.example.test", opened.page, {
          _tag: "Click",
          target: "1",
        }),
      ).toEqual({ _tag: "Stale" });
      expect(yield* runtime.observe("unrelated", "https://private.invalid")).toEqual({
        _tag: "Unavailable",
      });
      expect(yield* runtime.close(opened.tabId)).toBe(true);
      const events = readFileSync(join(directory, "events.jsonl"), "utf8");
      expect(events.match(/"operation":"click"/g)).toHaveLength(1);
      expect(events).not.toContain("private.invalid");
    }),
);

const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "osfo-browser-runtime-failure-"))),
    (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
  );
  const runtime = yield* BrowserRuntime.make({
    codexCommand: fileURLToPath(
      new URL("../test-fixtures/codex-browser-task.mjs", import.meta.url),
    ),
    codexHome: directory,
    hostSessionId: "owned-instance",
  });
  return { directory, runtime };
});

it.effect("retains Unknown after an executed click leaves the allowed observation origin", () =>
  Effect.gen(function* () {
    const { runtime, directory } = yield* fixture;
    const opened = yield* runtime.open("https://portal.example.test/cross-origin");
    if (opened._tag !== "Opened") return yield* Effect.die(new Error("fixture did not open"));
    expect(
      yield* runtime.interact(opened.tabId, "https://portal.example.test", opened.page, {
        _tag: "Click",
        target: "1",
      }),
    ).toEqual({ _tag: "Unknown" });
    expect(
      readFileSync(join(directory, "events.jsonl"), "utf8").match(/"operation":"click"/g),
    ).toHaveLength(1);
    return undefined;
  }),
);

it.effect(
  "refuses new effects after outer interruption even when the uncanceled CUA Promise settles",
  () =>
    Effect.gen(function* () {
      const { runtime, directory } = yield* fixture;
      const opened = yield* runtime.open("https://portal.example.test/delayed");
      if (opened._tag !== "Opened") return yield* Effect.die(new Error("fixture did not open"));
      const pending = yield* runtime
        .interact(opened.tabId, "https://portal.example.test", opened.page, {
          _tag: "Click",
          target: "1",
        })
        .pipe(Effect.forkChild);
      yield* waitForEvent(directory, "click");
      yield* Fiber.interrupt(pending);
      yield* Effect.sync(() => writeFileSync(join(directory, "release"), "release"));
      yield* waitForEvent(directory, "settled");
      // Let the installed Executor receive the late successful JSON-RPC response.
      yield* Effect.promise(() => setTimeout(100));
      expect(yield* runtime.open("https://portal.example.test/another")).toEqual({
        _tag: "Unavailable",
      });
      expect(
        readFileSync(join(directory, "events.jsonl"), "utf8").match(/"operation":"create"/g),
      ).toHaveLength(1);
      expect(yield* runtime.closeAll).toBe(true);
      return undefined;
    }),
);

const waitForEvent = Effect.fn(function* (directory: string, event: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (readFileSync(join(directory, "events.jsonl"), "utf8").includes(`"operation":"${event}"`))
      return undefined;
    yield* Effect.promise(() => setTimeout(10));
  }
  return yield* Effect.die(new Error("fixture event did not arrive"));
});

it.effect("reconciles closed tabs after more than an hour without browser activity", () =>
  Effect.gen(function* () {
    const { runtime } = yield* fixture;
    const opened = yield* runtime.open("https://portal.example.test/appointments");
    if (opened._tag !== "Opened") return yield* Effect.die(new Error("fixture did not open"));
    expect(yield* runtime.close(opened.tabId)).toBe(true);
    // oxlint-disable-next-line effecttsgo/global-date-in-effect -- The installed Executor idle pool reads Date.now directly.
    const now = Date.now();
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(Date, "now").mockReturnValue(now + 3_601_000)),
      (clock) => Effect.sync(() => clock.mockRestore()),
    );
    expect(yield* runtime.closeAll).toBe(true);
    expect(yield* runtime.close(opened.tabId)).toBe(true);
    return undefined;
  }),
);

it.effect("closes a retained open tab after more than an hour without browser activity", () =>
  Effect.gen(function* () {
    const { runtime, directory } = yield* fixture;
    const opened = yield* runtime.open("https://portal.example.test/appointments");
    if (opened._tag !== "Opened") return yield* Effect.die(new Error("fixture did not open"));
    // oxlint-disable-next-line effecttsgo/global-date-in-effect -- The installed Executor idle pool reads Date.now directly.
    const now = Date.now();
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(Date, "now").mockReturnValue(now + 3_601_000)),
      (clock) => Effect.sync(() => clock.mockRestore()),
    );
    expect(yield* runtime.closeAll).toBe(true);
    expect(yield* runtime.close(opened.tabId)).toBe(true);
    expect(
      readFileSync(join(directory, "events.jsonl"), "utf8").match(/"operation":"close"/g),
    ).toHaveLength(1);
    return undefined;
  }),
);
