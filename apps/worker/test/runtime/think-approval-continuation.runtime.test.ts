/* oxlint-disable effecttsgo/async-function, vitest/no-conditional-expect -- Native Think hooks and transport callbacks are Promise boundaries; parameterized cases assert their distinct native outcomes. */
import { Think, action } from "@cloudflare/think";
import { TextStreamCallback } from "@cloudflare/think/messengers";
import { expect, it } from "@effect/vitest";
import { jsonSchema } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";

it.each([
  { decision: "approve", autoContinue: false },
  { decision: "reject", autoContinue: false },
  { decision: "approve", autoContinue: undefined },
  { decision: "reject", autoContinue: undefined },
] as const)("retains native $decision outcomes with autoContinue=$autoContinue", async (test) => {
  const stub = env.OSFO_DIRECTORY.getByName(
    `native-approval-${test.decision}-${test.autoContinue}`,
  );
  await runInDurableObject(stub, async (directory) => {
    const think: Think = directory;
    await think.onStart();
    let effects = 0;
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls++;
        return {
          stream:
            modelCalls === 1
              ? convertArrayToReadableStream([
                  {
                    type: "tool-call",
                    toolCallId: "synthetic-call",
                    toolName: "syntheticAction",
                    input: '{"id":"synthetic-effect"}',
                  },
                  finish("tool-calls"),
                ])
              : convertArrayToReadableStream([
                  { type: "text-start", id: "reply" },
                  { type: "text-delta", id: "reply", delta: "The retained outcome is available." },
                  { type: "text-end", id: "reply" },
                  finish("stop"),
                ]),
        };
      },
    });
    const selected = vi.spyOn(think, "getModel").mockReturnValue(model);
    const configured = vi.spyOn(think, "beforeTurn").mockReturnValue({ maxSteps: 1 });
    const registered = vi.spyOn(think, "getActions").mockReturnValue({
      syntheticAction: action({
        description: "Record one synthetic effect",
        inputSchema: jsonSchema<{ id: string }>({
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        }),
        kind: "durable-pause",
        approval: true,
        idempotencyKey: ({ input }) => input.id,
        execute: () => {
          effects++;
          return "executed-once";
        },
      }),
    });
    try {
      await Think.prototype.chat.call(
        think,
        "Request the synthetic effect",
        new TextStreamCallback(),
      );
      const pending = await think.pendingApprovals();
      expect(pending).toHaveLength(1);
      const executionId = pending[0]?.executionId;
      if (executionId === undefined) throw new Error("Expected native pending approval");
      expect(effects).toBe(0);
      const options = test.autoContinue === false ? { autoContinue: false } : undefined;
      const outcome =
        test.decision === "approve"
          ? await think.approveExecution(executionId, options)
          : await think.rejectExecution(executionId, "Synthetic refusal", options);
      const retained = think.messages
        .flatMap((message) => message.parts)
        .find((part) => "toolCallId" in part && part.toolCallId === "synthetic-call");
      expect(retained).toMatchObject({ state: "output-available", output: outcome });
      expect(await think.pendingApprovals()).toEqual([]);
      expect(effects).toBe(test.decision === "approve" ? 1 : 0);
      if (test.decision === "approve") {
        expect(outcome).toBe("executed-once");
        expect(await think.approveExecution(executionId, options)).toMatchObject({
          status: "error",
        });
        expect(directory.sql`SELECT status FROM cf_think_action_ledger`).toEqual([
          { status: "settled" },
        ]);
      } else {
        expect(outcome).toMatchObject({ status: "rejected", reason: "Synthetic refusal" });
        expect(await think.rejectExecution(executionId, "Repeated refusal", options)).toMatchObject(
          { status: "error" },
        );
      }
      // This admitted turn drains behind any native auto-continuation already queued by resolution.
      await Think.prototype.chat.call(think, "Read the retained result", new TextStreamCallback());
      expect(modelCalls).toBe(test.autoContinue === false ? 2 : 3);
      expect(effects).toBe(test.decision === "approve" ? 1 : 0);
    } finally {
      registered.mockRestore();
      configured.mockRestore();
      selected.mockRestore();
    }
  });
});

const finish = (unified: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified, raw: unified },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
});
