/* oxlint-disable vitest/no-standalone-expect -- Effect generator assertions run inside it.effect. */
import type { PendingApproval, StepContext } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { notifyBrowserApproval } from "./browser-approval-notice";
const output = { status: "paused", action: "executeBrowserEffect", executionId: "actpause_exact" };
const result = {
  type: "tool-result",
  toolName: "executeBrowserEffect",
  toolCallId: "call",
  input: {},
  output,
} satisfies StepContext["toolResults"][number];
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
describe("browser approval notice", () => {
  it.effect("delivers one real review link only after checking the exact native pause", () =>
    Effect.gen(function* () {
      const delivered: Array<string> = [];
      const inspected: Array<string> = [];
      yield* notifyBrowserApproval({
        results: [result, result],
        webBaseUrl: new URL("https://osfo.test"),
        pending: (id) => {
          inspected.push(id);
          return Promise.resolve([pending]);
        },
        deliver: (text) => {
          delivered.push(text);
          return Promise.resolve();
        },
      });
      expect(inspected).toEqual([output.executionId]);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain("https://osfo.test/settings/browser");
      expect(delivered[0]).toContain("has not run yet");
    }),
  );
  it.effect.each([
    { name: "resolved", items: [] },
    { name: "different identity", items: [{ ...pending, executionId: "other" }] },
    {
      name: "different action",
      items: [{ ...pending, descriptor: { ...pending.descriptor, action: "other" } }],
    },
  ])("does not announce a $name pause", ({ items }) =>
    notifyBrowserApproval({
      results: [result],
      webBaseUrl: new URL("https://osfo.test"),
      pending: () => Promise.resolve(items),
      deliver: () => Promise.reject(new Error("Unexpected notice")),
    }),
  );
  it.effect("does not infer pending approval from an unclassified effect result", () =>
    notifyBrowserApproval({
      results: [{ ...result, output: { status: "unknown" } }],
      webBaseUrl: new URL("https://osfo.test"),
      pending: () => Promise.reject(new Error("Unexpected pending lookup")),
      deliver: () => Promise.reject(new Error("Unexpected notice")),
    }),
  );
});
