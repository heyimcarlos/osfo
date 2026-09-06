#!/usr/bin/env node
/* oxlint-disable effecttsgo/async-function -- This app-server fixture implements the documented CUA Promise interface. */
/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env -- This isolated protocol fixture executes generated adapter programs against synthetic browser objects only. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runInNewContext } from "node:vm";

const events = (value) =>
  appendFileSync(join(process.env.CODEX_HOME, "events.jsonl"), `${JSON.stringify(value)}\n`);
const tool = {
  inputSchema: {
    type: "object",
    properties: { code: { type: "string" }, title: { type: "string" } },
    required: ["code"],
  },
};
const tabs = new Map();
let output = [];
const context = {
  URL,
  Map,
  JSON,
  Number,
  RegExp,
  nodeRepl: { write: (text) => output.push({ type: "text", text }) },
  cua: {
    getState: async () => {
      output.push({
        type: "text",
        text: JSON.stringify({
          browsers: [
            {
              id: "owned-chrome",
              name: "Chrome",
              family: "chrome",
              type: "extension",
              metadata: { extensionInstanceId: "owned-instance" },
            },
          ],
        }),
      });
    },
    getBrowser: async ({ id }) => {
      if (id !== "owned-chrome") throw new Error("wrong browser");
      return { browserId: id };
    },
    createBrowserTab: async (browserId, url, options) => {
      if (browserId !== "owned-chrome" || !options.sessionName) throw new Error("wrong ownership");
      const id = `owned-tab-${tabs.size + 1}`;
      const tab = {
        id,
        url,
        text: "0 AXWebArea Booking portal\n  1 AXButton Confirm appointment",
        goto: async (destination) => {
          tab.url = destination;
          events({ operation: "goto", id, destination });
        },
        getAXState: async () => tab.text,
        click: async (target) => {
          events({ operation: "click", id, target });
          tab.text =
            "0 AXWebArea Confirmed\n  1 AXStaticText Confirmation SYNTHETIC-1\n  2 AXLink Cancel appointment";
        },
        setValue: async (target, value) => {
          events({ operation: "setValue", id, target, value });
        },
        close: async () => {
          events({ operation: "close", id });
          tabs.delete(id);
        },
      };
      tabs.set(id, tab);
      events({ operation: "create", id });
      return tab;
    },
    listTabs: async ({ browser }) => {
      if (browser !== "owned-chrome") throw new Error("wrong browser");
      return [
        ...Array.from(tabs.values()).map((tab) => ({ id: tab.id, url: tab.url })),
        { id: "unrelated", url: "https://private.invalid", title: "Never read this" },
      ];
    },
  },
};
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  output = [];
  const result = await (async () => {
    switch (message.method) {
      case "initialize":
        return {};
      case "thread/start":
        return { thread: { id: "fixture-returned-thread" } };
      case "mcpServerStatus/list":
        return { data: [{ name: "cua_repl", tools: { js: tool } }], nextCursor: null };
      case "mcpServer/tool/call": {
        try {
          const code = message.params.arguments.code.replace(/^var (\w+) =/, "globalThis.$1 =");
          await runInNewContext(`(async () => { ${code} })()`, context);
          return { content: output };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error.message }] };
        }
      }
      default:
        return {};
    }
  })();
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
