#!/usr/bin/env node
/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env -- This standalone protocol fixture intentionally has no application runtime dependencies. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const tool = {
  inputSchema: {
    type: "object",
    properties: { code: { type: "string" }, title: { type: "string" } },
    required: ["code"],
  },
};
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  appendFileSync(join(process.env.CODEX_HOME, "calls.jsonl"), `${JSON.stringify(message)}\n`);
  if (message.id === undefined) continue;
  const result = (() => {
    switch (message.method) {
      case "initialize":
        return {};
      case "thread/start":
        return { thread: { id: "fixture-returned-thread" } };
      case "mcpServerStatus/list":
        return {
          data: [{ name: "cua_repl", tools: { js: tool, js_reset: tool, forbidden: tool } }],
          nextCursor: null,
        };
      case "mcpServer/tool/call":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                browsers: [
                  {
                    id: "owned",
                    name: "Owned browser",
                    metadata: { extensionInstanceId: "owned-instance" },
                    tabs: [{ title: "Private title", url: "https://private.invalid" }],
                  },
                  {
                    id: "unrelated",
                    name: "Unrelated browser",
                    metadata: { extensionInstanceId: "other-instance" },
                    tabs: [],
                  },
                ],
              }),
            },
          ],
        };
      default:
        return {};
    }
  })();
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
