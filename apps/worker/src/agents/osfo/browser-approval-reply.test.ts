/* oxlint-disable vitest/no-standalone-expect -- Effect generator assertions run inside it.effect. */
import type { PendingApproval } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { appendBrowserApprovalLink } from "./browser-approval-reply";
const output = { status: "paused", action: "executeBrowserEffect", executionId: "actpause_exact" };
const part = {
  type: "tool-executeBrowserEffect",
  toolCallId: "call",
  toolName: "executeBrowserEffect",
  state: "output-available",
  input: {},
  output,
};

const pending: PendingApproval = {
  executionId: output.executionId,
  source: "action",
  descriptor: {
    requestId: "request",
    toolCallId: "call",
    action: "executeBrowserEffect",
    summary: "Click the shown choice",
    input: {},
    permissions: ["browser:interact"],
    kind: "durable-pause",
  },
};
describe("browser approval reply", () => {
  it.effect(
    "adds the real review link to committed text only after checking its exact native pause",
    () =>
      Effect.gen(function* () {
        const inspected: Array<string> = [];
        const text = yield* appendBrowserApprovalLink({
          parts: [
            { type: "step-start" },
            part,
            { type: "text", text: "Waiting for your decision." },
          ],
          text: "Waiting for your decision.",
          webBaseUrl: new URL("https://osfo.test"),
          pending: (id) => {
            inspected.push(id);
            return Promise.resolve([pending]);
          },
        });
        expect(inspected).toEqual([output.executionId]);
        expect(text).toContain("Waiting for your decision.");
        expect(text).toContain("https://osfo.test/settings/browser");
        expect(text).toContain("has not run yet");
      }),
  );
  it.effect.each([
    { name: "resolved", items: [] },
    { name: "different identity", items: [{ ...pending, executionId: "other" }] },
    {
      name: "different action",
      items: [{ ...pending, descriptor: { ...pending.descriptor, action: "other" } }],
    },
  ])("does not append a link for a $name pause", ({ items }) =>
    Effect.gen(function* () {
      const text = yield* appendBrowserApprovalLink({
        parts: [part],
        text: "Retained reply",
        webBaseUrl: new URL("https://osfo.test"),
        pending: () => Promise.resolve(items),
      });
      expect(text).toBe("Retained reply");
    }),
  );
  it.effect("does not infer a pending browser approval from prose or another tool", () =>
    Effect.gen(function* () {
      const text = yield* appendBrowserApprovalLink({
        parts: [
          { type: "text", text: "paused" },
          { ...part, type: "tool-other" },
          { ...part, output: { status: "unknown" } },
        ],
        text: "Retained reply",
        webBaseUrl: new URL("https://osfo.test"),
        pending: () => Promise.reject(new Error("Unexpected lookup")),
      });
      expect(text).toBe("Retained reply");
    }),
  );
});
