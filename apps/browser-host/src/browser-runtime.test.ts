/* oxlint-disable eslint/no-underscore-dangle -- Browser wire outcomes use the canonical _tag discriminator. */
/* oxlint-disable effecttsgo/node-builtin-import -- The real Executor bridge launches an isolated synthetic protocol fixture. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

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
