/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect-owned native Durable Object callback. */
/* oxlint-disable effecttsgo/async-function -- Native Durable Object and installed messenger callbacks are Promise boundaries. */
import { createHmac } from "node:crypto";
import type { UIMessage } from "ai";
import type { Think } from "@cloudflare/think";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { ThinkMessengerRuntime, type MessengerThinkHost } from "@cloudflare/think/messengers";
import { it, expect } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Deferred, Effect, Predicate } from "effect";
import { vi } from "vitest";

import { makeWhatsAppChannel } from "./whatsapp";

type MessengerAdmission =
  | { readonly kind: "unavailable" }
  | { readonly kind: "submission"; readonly submissionId: string };

it.effect("persists recoverable WhatsApp input before acknowledging the real signed webhook", () =>
  Effect.promise(async () => {
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "https://whatsapp-ingress.test/v25.0/123456789/messages") {
        throw new Error(`Unexpected provider request: ${url}`);
      }
      return Response.json({
        success: true,
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.reply" }],
      });
    });
    try {
      const stub = env.OSFO_DIRECTORY.getByName("whatsapp-ingress-acknowledgement");
      const observed = await runInDurableObject(stub, async (directory, state) => {
        const completed = Deferred.makeUnsafe<void>();
        const think: Think = directory;
        await think.onStart();
        const model = new MockLanguageModelV3({
          doStream: {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Your retained reminder." },
              { type: "text-end", id: "answer" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ]),
          },
        });
        const selected = vi.spyOn(think, "getModel").mockReturnValue(model);
        let admissionAvailable = false;
        let deliveryAvailable = false;
        const host = {
          prepareMessengerInput: () =>
            Promise.resolve(
              admissionAvailable
                ? { kind: "route", agentId: "original-owner" }
                : { kind: "unavailable" },
            ),
          acceptMessengerInput: async (message: string | UIMessage) => {
            if (!admissionAvailable) return { kind: "unavailable" };
            const input = Predicate.isString(message)
              ? {
                  id: "durable-user",
                  role: "user" as const,
                  parts: [{ type: "text" as const, text: message }],
                }
              : message;
            const submission = await think.submitMessages([input], {
              submissionId: "durable-whatsapp",
              idempotencyKey: "exact-whatsapp-message",
            });
            state.storage.sql.exec(
              "CREATE TABLE IF NOT EXISTS test_acceptance_receipt (message_id TEXT PRIMARY KEY, submission_id TEXT NOT NULL)",
            );
            state.storage.sql.exec(
              "INSERT OR IGNORE INTO test_acceptance_receipt VALUES (?, ?)",
              input.id,
              submission.submissionId,
            );
            return { kind: "submission", submissionId: submission.submissionId };
          },
          followMessengerInput: async () => {
            await think.waitForSubmission("durable-whatsapp");
            if (!deliveryAvailable) return { kind: "unavailable" as const };
            await Effect.runPromise(Deferred.succeed(completed, undefined));
            return "Your retained reminder.";
          },
          cancelChat: () => Promise.resolve(true),
          chat: () => Promise.resolve(),
          chatWithMessengerContext: async (_message, callback) => {
            await callback.onEvent(JSON.stringify({ type: "text-delta", delta: "Acknowledged" }));
          },
          constructor: { name: "OsfoDirectory" },
          name: directory.name,
          parentPath: directory.parentPath,
          inspectFiberByKey: directory.inspectFiberByKey.bind(directory),
          resolveFiber: directory.resolveFiber.bind(directory),
          startFiber: async (name, execute, options) => {
            try {
              return await directory.startFiber(name, execute, options);
            } finally {
              if (options?.waitForCompletion)
                await Effect.runPromise(Deferred.succeed(completed, undefined));
            }
          },
          subAgent: directory.subAgent.bind(directory),
        } satisfies MessengerThinkHost & {
          acceptMessengerInput: (message: string | UIMessage) => Promise<MessengerAdmission>;
          followMessengerInput: () => Promise<string | { readonly kind: "unavailable" }>;
        };
        const channel = makeWhatsAppChannel({
          accessToken: "test-access-token",
          apiUrl: "https://whatsapp-ingress.test",
          appSecret: "test-app-secret",
          conversation: () => Promise.resolve({ target: "self" }),
          phoneNumberId: "123456789",
          userName: "test-whatsapp",
          verifyToken: "test-verify-token",
        });
        if (channel.ingress.transport !== "webhook") throw new Error("Expected webhook ingress");
        const { transport: _transport, ...definition } = channel.ingress;
        const runtime = new ThinkMessengerRuntime({ whatsapp: definition }, host);
        runtime.initialize();
        const body = JSON.stringify({
          object: "whatsapp_business_account",
          entry: [
            {
              id: "test-business",
              changes: [
                {
                  field: "messages",
                  value: {
                    messaging_product: "whatsapp",
                    metadata: { phone_number_id: "123456789", display_phone_number: "15555550100" },
                    contacts: [{ wa_id: "15555550101", profile: { name: "Test" } }],
                    messages: [
                      {
                        from: "15555550101",
                        id: "wamid.ingress-ordering",
                        timestamp: "1700000000",
                        type: "text",
                        text: { body: "What was my reminder?" },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });
        const request = () =>
          new Request("https://osfo.test/webhooks/whatsapp", {
            body,
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": `sha256=${createHmac("sha256", "test-app-secret").update(body).digest("hex")}`,
            },
            method: "POST",
          });
        expect((await runtime.handleRequest(request()))?.status).toBe(503);
        expect(await directory.listFibers()).toHaveLength(0);
        admissionAvailable = true;
        const response = await runtime.handleRequest(request());
        const fibers = state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM cf_agents_fibers WHERE name = 'think:messenger-reply' AND snapshot IS NOT NULL",
          )
          .one().count;
        const submissionTableExists =
          state.storage.sql
            .exec("SELECT 1 FROM sqlite_master WHERE name = 'cf_think_submissions'")
            .toArray().length > 0;
        const submissions = submissionTableExists
          ? state.storage.sql
              .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cf_think_submissions")
              .one().count
          : 0;
        // Drain the real adapter's detached task before the test leaves its native object.
        // oxlint-disable-next-line eslint/no-underscore-dangle -- Drive the installed native submission scheduler in this boundary test.
        await think._drainThinkSubmissions();
        await vi.waitFor(async () => {
          expect((await directory.listFibers())[0]).toMatchObject({
            status: "pending",
            snapshot: { stage: "accepted" },
          });
          expect(
            state.storage.sql
              .exec("SELECT 1 FROM cf_agents_runs WHERE name = 'think:messenger-reply'")
              .toArray(),
          ).toHaveLength(0);
        });
        expect(provider).not.toHaveBeenCalled();
        deliveryAvailable = true;
        const recovered = vi.fn<ThinkMessengerRuntime["handleFiberRecovery"]>((fiber) =>
          runtime.handleFiberRecovery(fiber),
        );
        // Route the installed protected recovery hook to this test's messenger composition.
        const recoveryHook = "_handleInternalFiberRecovery";
        const originalHook = Object.getOwnPropertyDescriptor(directory, recoveryHook);
        Object.defineProperty(directory, recoveryHook, { configurable: true, value: recovered });
        try {
          await directory.alarm();
          expect(recovered).toHaveBeenCalledTimes(1);
        } finally {
          if (originalHook) Object.defineProperty(directory, recoveryHook, originalHook);
          else Reflect.deleteProperty(directory, recoveryHook);
        }
        await Effect.runPromise(Deferred.await(completed));
        selected.mockRestore();
        const fiber = (await directory.listFibers()).find(
          (item) => item.name === "think:messenger-reply",
        );
        if (fiber !== undefined)
          await directory.startFiber("think:messenger-reply", async () => {}, {
            fiberId: fiber.fiberId,
            waitForCompletion: true,
          });
        const completedFibers = state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM cf_agents_fibers WHERE name = 'think:messenger-reply' AND status = 'completed'",
          )
          .one().count;
        expect((await runtime.handleRequest(request()))?.status).toBe(200);
        expect(provider).toHaveBeenCalledTimes(1);
        state.storage.sql.exec(
          "INSERT INTO cf_agents_fibers (fiber_id, idempotency_key, name, status, snapshot, created_at) SELECT 'ambiguous-reply', 'ambiguous-provider-input', name, 'interrupted', json_set(snapshot, '$.stage', 'streaming'), 1 FROM cf_agents_fibers WHERE name = 'think:messenger-reply' LIMIT 1",
        );
        const interrupted = await directory.inspectFiber("ambiguous-reply");
        if (interrupted === null) throw new Error("Missing interrupted native reply");
        expect(
          await runtime.handleFiberRecovery({
            id: interrupted.fiberId,
            name: interrupted.name,
            snapshot: interrupted.snapshot,
            createdAt: interrupted.createdAt,
            recoveryReason: "interrupted",
          }),
        ).toBe(true);
        expect(await directory.inspectFiber("ambiguous-reply")).toMatchObject({
          status: "error",
          error: "Accepted messenger reply delivery outcome is unknown",
        });
        expect(provider).toHaveBeenCalledTimes(1);
        expect(model.doStreamCalls).toHaveLength(1);
        return { completedFibers, fibers, status: response?.status, submissions };
      });
      expect(observed.status).toBe(200);
      expect(observed.completedFibers).toBe(1);
      expect(observed.fibers).toBe(1);
      expect(observed.submissions).toBe(1);
    } finally {
      provider.mockRestore();
    }
  }),
);
