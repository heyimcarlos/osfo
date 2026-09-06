import { createExecutor, ProviderKey } from "@executor-js/sdk";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import type { InventoryResponse } from "@osfo/api/browser-host";
import { Clock, Effect, Option, Schema } from "effect";

const McpResult = Schema.Struct({
  ok: Schema.Literal(true),
  data: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    content: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
});
const State = Schema.fromJsonString(
  Schema.Struct({
    browsers: Schema.Array(
      Schema.Struct({
        id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        metadata: Schema.optional(
          Schema.Struct({ extensionInstanceId: Schema.optional(Schema.String) }),
        ),
        tabs: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100_000)),
      }),
    ).check(Schema.isMaxLength(16)),
  }),
);

export interface Options {
  readonly codexCommand: string;
  readonly codexHome: string;
  readonly hostSessionId: string;
}

/** Keep the Promise/SDK boundary here. Only one fixed read program can reach the host. */
export const inspect = Effect.fn("ExecutorBrowser.inspect")(
  function* (options: Options) {
    const credentials = new Map<string, string>();
    let approvalRequired = false;
    const executor = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        createExecutor({
          providers: [
            {
              key: ProviderKey.make("default"),
              writable: true,
              get: (id) => Effect.sync(() => credentials.get(id) ?? null),
              set: (id, value) =>
                Effect.sync(() => {
                  credentials.set(id, value);
                }),
              delete: (id) =>
                Effect.sync(() => {
                  credentials.delete(id);
                }),
            },
          ],
          onElicitation: () => {
            approvalRequired = true;
            return { action: "cancel" };
          },
          plugins: [mcpPlugin({ dangerouslyAllowStdioMCP: true })],
        }),
      ),
      (resource) => Effect.promise(() => resource.close()),
    );
    yield* Effect.tryPromise(() =>
      executor.mcp.addServer({
        transport: "stdio",
        name: "Private browser inventory",
        slug: "browser_inventory",
        command: options.codexCommand,
        args: ["app-server"],
        staticEnv: { CODEX_HOME: options.codexHome },
        appServer: { server: "cua_repl" },
      }),
    );
    yield* Effect.tryPromise(() =>
      executor.policies.create({ owner: "org", pattern: "*", action: "block", position: "a1" }),
    );
    yield* Effect.tryPromise(() =>
      executor.policies.create({
        owner: "org",
        pattern: "browser_inventory.org.default.js",
        action: "approve",
        position: "a0",
      }),
    );
    const result = yield* Effect.tryPromise(() =>
      executor.execute("tools.browser_inventory.org.default.js", {
        code: "await cua.getState();",
        title: "Read browser inventory only",
      }),
    );
    if (approvalRequired) return { _tag: "ApprovalRequired" } as const;
    const decoded = Schema.decodeUnknownOption(McpResult)(result);
    if (Option.isNone(decoded) || decoded.value.data.isError === true)
      return { _tag: "Unknown" } as const;
    const states = decoded.value.data.content.flatMap((content) => {
      if (content.type !== "text" || content.text === undefined || content.text.length > 1_000_000)
        return [];
      const state = Schema.decodeOption(State)(content.text);
      return Option.isSome(state) ? [state.value] : [];
    });
    const state = states[0];
    if (state === undefined || states.length !== 1) return { _tag: "Unknown" } as const;
    const ownedBrowsers = state.browsers.filter(
      (browser) => browser.metadata?.extensionInstanceId === options.hostSessionId,
    );
    if (ownedBrowsers.length !== 1) return { _tag: "Unavailable" } as const;
    return {
      _tag: "Observed",
      browsers: ownedBrowsers.map((browser) => ({
        id: browser.id,
        name: browser.name,
        tabCount: browser.tabs.length,
      })),
      observedAt: yield* Clock.currentTimeMillis,
    } satisfies InventoryResponse["outcome"];
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("15 seconds"),
      Effect.scoped,
      Effect.orElseSucceed(() => ({ _tag: "Unknown" }) as const),
    ),
);
