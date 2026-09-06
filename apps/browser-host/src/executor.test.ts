/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json -- Real Node filesystem fixtures and deliberate malformed wire payloads test the transport boundary. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { createExecutor, ProviderKey } from "@executor-js/sdk";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { vi } from "vitest";

import { inspect } from "./executor.ts";

const RecordedCall = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.String,
    params: Schema.optional(Schema.Unknown),
  }),
);

it.effect(
  "uses the published Executor bridge with returned thread identity and projects only the bound browser",
  () =>
    Effect.gen(function* () {
      const path = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "osfo-executor-protocol-"))),
        (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const outcome = yield* inspect({
        codexCommand: fileURLToPath(
          new URL("../test-fixtures/codex-app-server.mjs", import.meta.url),
        ),
        codexHome: path,
        hostSessionId: "owned-instance",
      });
      expect(outcome).toMatchObject({
        _tag: "Observed",
        browsers: [{ id: "owned", name: "Owned browser", tabCount: 1 }],
      });
      expect(JSON.stringify(outcome)).not.toContain("Private title");
      expect(JSON.stringify(outcome)).not.toContain("Unrelated browser");
      const calls = readFileSync(join(path, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => Schema.decodeSync(RecordedCall)(line));
      const toolCalls = calls.filter((call) => call.method === "mcpServer/tool/call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.params).toMatchObject({
        threadId: "fixture-returned-thread",
        server: "cua_repl",
        tool: "js",
        arguments: { code: "await cua.getState();" },
        _meta: {
          "x-codex-turn-metadata": {
            session_id: "fixture-returned-thread",
            turn_id: expect.any(String),
          },
        },
      });
      expect(
        calls
          .filter((call) => call.method === "thread/start")
          .every((call) =>
            Schema.is(Schema.Struct({ ephemeral: Schema.Literal(true) }))(call.params),
          ),
      ).toBe(true);
    }),
);

it.effect("keeps the default Executor connection expiry for other plugin instances", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "osfo-executor-expiry-"))),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    );
    const executor = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        createExecutor({
          providers: [
            {
              key: ProviderKey.make("default"),
              writable: true,
              get: () => Effect.succeed(null),
              set: () => Effect.void,
              delete: () => Effect.void,
            },
          ],
          onElicitation: () => ({ action: "cancel" }),
          plugins: [mcpPlugin({ dangerouslyAllowStdioMCP: true })],
        }),
      ),
      (resource) => Effect.promise(() => resource.close()),
    );
    yield* Effect.tryPromise(() =>
      executor.mcp.addServer({
        transport: "stdio",
        name: "Synthetic expiry test",
        slug: "expiry",
        command: fileURLToPath(new URL("../test-fixtures/codex-browser-task.mjs", import.meta.url)),
        staticEnv: { CODEX_HOME: directory },
        appServer: { server: "cua_repl" },
      }),
    );
    yield* Effect.tryPromise(() =>
      executor.policies.create({
        owner: "org",
        pattern: "*",
        action: "approve",
        position: "a0",
      }),
    );
    yield* Effect.tryPromise(() =>
      executor.execute("tools.expiry.org.default.js", {
        code: "var retainedValue = 1;",
      }),
    );
    const read = () =>
      Effect.tryPromise(() =>
        executor.execute("tools.expiry.org.default.js", {
          code: "nodeRepl.write(JSON.stringify(retainedValue));",
        }),
      );
    expect(yield* read()).toMatchObject({ ok: true, data: { content: [{ text: "1" }] } });
    // oxlint-disable-next-line effecttsgo/global-date-in-effect -- The installed Executor idle pool reads Date.now directly.
    const now = Date.now();
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(Date, "now").mockReturnValue(now + 301_000)),
      (clock) => Effect.sync(() => clock.mockRestore()),
    );
    expect(yield* read()).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("retainedValue is not defined") },
    });
  }),
);
