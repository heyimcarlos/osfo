/* oxlint-disable eslint/no-underscore-dangle -- Browser wire outcomes use the canonical _tag discriminator. */
import { createExecutor, ProviderKey } from "@executor-js/sdk";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { Data, Effect, Option, Schema } from "effect";

import type { BrowserTask } from "./browser-task.ts";

const jsString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const Result = Schema.TaggedUnion({
  Opened: {
    tabId: Schema.String,
    page: Schema.Struct({ url: Schema.String, text: Schema.String }),
  },
  Page: { page: Schema.Struct({ url: Schema.String, text: Schema.String }) },
  Closed: {},
  Stale: {},
  HumanRequired: {},
  Unknown: {},
  Unavailable: {},
});
const McpResult = Schema.Struct({
  ok: Schema.Literal(true),
  data: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    content: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
});
const Inventory = Schema.fromJsonString(
  Schema.Struct({
    browsers: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.optional(Schema.String),
        family: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
        metadata: Schema.optional(
          Schema.Struct({ extensionInstanceId: Schema.optional(Schema.String) }),
        ),
      }),
    ),
  }),
);

export interface Options {
  readonly codexCommand: string;
  readonly codexHome: string;
  readonly hostSessionId: string;
}

class Unavailable extends Data.TaggedError("BrowserRuntimeUnavailable") {}

/** One scoped CUA connection owns only the tabs it creates in the provisioned Chrome extension. */
export const make = Effect.fn("BrowserRuntime.make")(function* (options: Options) {
  const credentials = new Map<string, string>();
  let elicited = false;
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
          elicited = true;
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
      name: "Owned browser task",
      slug: "browser_task",
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
      pattern: "browser_task.org.default.js",
      action: "approve",
      position: "a0",
    }),
  );
  let pending = false;
  let uncertain = false;
  const call = (code: string) =>
    Effect.tryPromise(() => {
      pending = true;
      return executor
        .execute("tools.browser_task.org.default.js", {
          code,
          title: "Operate only the owned browser task",
        })
        .finally(() => {
          pending = false;
        });
    });
  const inventory = yield* call("await cua.getState();");
  const decoded = yield* Schema.decodeUnknownEffect(McpResult)(inventory);
  const browsers = decoded.data.content.flatMap((block) => {
    if (block.type !== "text" || block.text === undefined) return [];
    const state = Schema.decodeOption(Inventory)(block.text);
    return Option.isSome(state) ? state.value.browsers : [];
  });
  const matched = browsers.filter(
    (browser) =>
      browser.metadata?.extensionInstanceId === options.hostSessionId &&
      (browser.family === "chrome" || browser.name === "Chrome"),
  );
  const selected = matched[0];
  if (selected === undefined || matched.length !== 1 || elicited) return yield* new Unavailable();
  yield* call(`var osfoBrowser = await cua.getBrowser({ id: ${jsString(selected.id)} });`);
  yield* call("var osfoTabs = new Map();");
  yield* call("var osfoClosedTabs = new Set();");
  const run = Effect.fn("BrowserRuntime.run")(function* (program: string, cleanup = false) {
    if (pending || (uncertain && !cleanup)) return { _tag: "Unknown" } as const;
    elicited = false;
    const result = yield* call(
      `nodeRepl.write(JSON.stringify(await (async () => { ${program} })()));`,
    ).pipe(Effect.timeout("20 seconds"), Effect.option);
    if (elicited) return { _tag: "HumanRequired" } as const;
    if (Option.isNone(result)) {
      // Interruption cannot cancel CUA's in-flight Promise. Refuse subsequent effects.
      uncertain = true;
      return { _tag: "Unknown" } as const;
    }
    const envelope = Schema.decodeUnknownOption(McpResult)(result.value);
    if (Option.isNone(envelope) || envelope.value.data.isError === true)
      return { _tag: "Unknown" } as const;
    const outcomes = envelope.value.data.content.flatMap((block) => {
      if (block.type !== "text" || block.text === undefined || block.text.length > 262_144)
        return [];
      const outcome = Schema.decodeOption(Schema.fromJsonString(Result))(block.text);
      return Option.isSome(outcome) ? [outcome.value] : [];
    });
    return outcomes.length === 1
      ? (outcomes[0] ?? ({ _tag: "Unknown" } as const))
      : ({ _tag: "Unknown" } as const);
  });
  const closeAll = run(
    `
    for (const tab of osfoTabs.values()) {
      await tab.close(); osfoTabs.delete(tab.id); osfoClosedTabs.add(tab.id);
    }
    return { _tag: "Closed" };
  `,
    true,
  ).pipe(Effect.map((outcome) => outcome._tag === "Closed"));
  yield* Effect.addFinalizer(() => closeAll.pipe(Effect.asVoid));
  return {
    closeAll,
    open: (url) =>
      run(`
      const tab = await cua.createBrowserTab(osfoBrowser.browserId, "about:blank", { sessionName: "🔎 Osfo browser task" });
      osfoTabs.set(tab.id, tab);
      await tab.goto(${jsString(url)});
      ${readPage(new URL(url).origin)}
      return { _tag: "Opened", tabId: tab.id, page };
    `).pipe(
        Effect.map((outcome) =>
          outcome._tag === "Opened" ||
          outcome._tag === "HumanRequired" ||
          outcome._tag === "Unavailable"
            ? outcome
            : ({ _tag: "Unknown" } as const),
        ),
      ),
    observe: (tabId, origin) =>
      run(`
      const tab = osfoTabs.get(${jsString(tabId)});
      if (!tab) return { _tag: "Unavailable" };
      ${readPage(origin)}
      return { _tag: "Page", page };
    `).pipe(Effect.map(pageOutcome)),
    interact: (tabId, origin, expected, interaction) =>
      run(`
      const tab = osfoTabs.get(${jsString(tabId)});
      if (!tab) return { _tag: "Unavailable" };
      ${readPage(origin)}
      if (page.url !== ${jsString(expected.url)} || page.text !== ${jsString(expected.text)}) return { _tag: "Stale" };
      const target = ${jsString(interaction.target)};
      if (!/^[0-9]+$/.test(target) || !Number.isSafeInteger(Number(target)) || !page.text.split(String.fromCharCode(10)).some((line) => line.trim().startsWith(target + " "))) return { _tag: "Stale" };
      ${interaction._tag === "Click" ? "await tab.click(Number(target));" : `await tab.setValue(Number(target), ${jsString(interaction.value)});`}
      ${readPage(origin, "after")}
      return { _tag: "Page", page: after };
    `).pipe(Effect.map((outcome) => (outcome._tag === "Stale" ? outcome : pageOutcome(outcome)))),
    close: (tabId) =>
      run(
        `
      const tab = osfoTabs.get(${jsString(tabId)});
      if (!tab) {
        if (osfoClosedTabs.has(${jsString(tabId)})) return { _tag: "Closed" };
        const tabs = await cua.listTabs({ browser: osfoBrowser.browserId, emit: false });
        return { _tag: tabs.some((candidate) => candidate.id === ${jsString(tabId)}) ? "Unavailable" : "Closed" };
      }
      await tab.close(); osfoTabs.delete(tab.id); osfoClosedTabs.add(tab.id);
      return { _tag: "Closed" };
    `,
        true,
      ).pipe(Effect.map((outcome) => outcome._tag === "Closed")),
  } satisfies BrowserTask.Runtime;
});

const pageOutcome = (outcome: typeof Result.Type) =>
  outcome._tag === "Page" || outcome._tag === "HumanRequired" || outcome._tag === "Unavailable"
    ? outcome
    : ({ _tag: "Unknown" } as const);

/** URL checks precede page reads; unrelated tab metadata never leaves the REPL program. */
const readPage = (origin: string, variable = "page") => `
  const ${variable}Tabs = await cua.listTabs({ browser: osfoBrowser.browserId, emit: false });
  const ${variable}Tab = ${variable}Tabs.find((candidate) => candidate.id === tab.id);
  if (!${variable}Tab?.url || new URL(${variable}Tab.url).origin !== ${jsString(origin)}) return { _tag: "Unavailable" };
  const ${variable}Text = await tab.getAXState({ emit: false, disableDiffing: true });
  if (${variable}Text.length === 0 || ${variable}Text.length > 48000) return { _tag: "Unavailable" };
  const ${variable} = { url: ${variable}Tab.url, text: ${variable}Text };
`;

export * as BrowserRuntime from "./browser-runtime.ts";
