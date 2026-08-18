import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "@effect/vitest";
import type { FiberContext } from "@cloudflare/think";
import {
  ThinkMessengerRuntime,
  ThinkMessengerStateAgent,
  type MessengerEvent,
  type MessengerThinkHost,
} from "@cloudflare/think/messengers";
import { Effect } from "effect";

import { OsfoAgent } from "../src/agents/osfo/agent";
import { makeWhatsAppChannel } from "../src/integrations/whatsapp";

/* oxlint-disable effecttsgo/async-function, effecttsgo/crypto-random-uuid, effecttsgo/global-date, effecttsgo/prefer-schema-over-json, osfo/no-chained-type-assertions, osfo/no-runtime-typeof, osfo/no-unsafe-dictionary-type, osfo/no-unknown-parameters, osfo/require-safety-comment-for-type-assertion, typescript/no-base-to-string, typescript/no-unnecessary-type-assertion, typescript/no-unsafe-type-assertion -- Framework test doubles implement Promise-based Cloudflare and Chat SDK boundaries with typed fixture payloads and runtime-compatible host casts. */

describe("Think WhatsApp framework path", () => {
  it.effect(
    "verifies, normalizes, routes, deduplicates, and delivers a signed direct message",
    () =>
      Effect.gen(function* () {
        const metaRequests: Array<unknown> = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
          const body: unknown =
            init?.body === undefined ? undefined : JSON.parse(String(init.body));
          metaRequests.push(body);
          return Response.json(
            isTypingRequest(body) ? { success: true } : { messages: [{ id: "wamid.reply-1" }] },
          );
        });

        const events: Array<MessengerEvent> = [];
        const modelInputs: Array<string> = [];
        const host = new FrameworkHost(events, modelInputs);
        const channel = makeWhatsAppChannel({
          accessToken: "test-access-token",
          appSecret: APP_SECRET,
          conversation: (event) => {
            events.push(event);
            return { agentClass: OsfoAgent, name: "agent-1", target: "subagent" };
          },
          phoneNumberId: "123456789",
          userName: "osfo_test",
          verifyToken: "test-verify-token",
        });
        if (channel.ingress.transport !== "webhook") throw new Error("Expected webhook ingress");
        const { transport: _transport, ...messenger } = channel.ingress;
        const runtime = new ThinkMessengerRuntime(
          { whatsapp: messenger },
          // SAFETY: FrameworkHost implements the runtime methods used by Think. The test replaces only Cloudflare Agent storage and facet RPC.
          host as unknown as MessengerThinkHost,
        );
        runtime.initialize();
        const signedRequest = request(whatsAppPayload);

        const first = yield* Effect.promise(() =>
          runtime.handleRequest(signedRequest.clone() as unknown as RuntimeRequest),
        );
        const duplicate = yield* Effect.promise(() =>
          runtime.handleRequest(signedRequest.clone() as unknown as RuntimeRequest),
        );

        yield* Effect.promise(() =>
          vi.waitFor(
            () => {
              expect(modelInputs).toHaveLength(1);
            },
            { timeout: 5_000 },
          ),
        );

        expect(first?.status).toBe(200);
        expect(duplicate?.status).toBe(200);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          kind: "direct-message",
          message: {
            author: { userId: "15551234567" },
            providerMessageId: "wamid.inbound-1",
            text: "Hello from WhatsApp",
          },
          provider: "whatsapp",
        });
        expect(host.resolvedFacetNames).toEqual(["agent-1"]);
        expect(modelInputs).toEqual(["Hello from WhatsApp"]);
        expect(metaRequests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              messaging_product: "whatsapp",
              text: expect.objectContaining({ body: "*Hello from Osfo*" }),
              to: "15551234567",
              type: "text",
            }),
          ]),
        );
      }),
  );

  it.effect("rejects an invalid signature before normalization", () =>
    Effect.gen(function* () {
      const events: Array<MessengerEvent> = [];
      const host = new FrameworkHost(events, []);
      const channel = makeWhatsAppChannel({
        accessToken: "test-access-token",
        appSecret: APP_SECRET,
        conversation: (event) => {
          events.push(event);
          return { agentClass: OsfoAgent, name: "agent-1", target: "subagent" };
        },
        phoneNumberId: "123456789",
        userName: "osfo_test",
        verifyToken: "test-verify-token",
      });
      if (channel.ingress.transport !== "webhook") throw new Error("Expected webhook ingress");
      const { transport: _transport, ...messenger } = channel.ingress;
      const runtime = new ThinkMessengerRuntime(
        { whatsapp: messenger },
        // SAFETY: FrameworkHost implements the runtime methods used by Think. The test replaces only Cloudflare Agent storage and facet RPC.
        host as unknown as MessengerThinkHost,
      );
      runtime.initialize();

      const response = yield* Effect.promise(() =>
        runtime.handleRequest(
          new Request("https://osfo.test/webhooks/whatsapp", {
            body: JSON.stringify(whatsAppPayload),
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": "sha256=invalid",
            },
            method: "POST",
          }) as unknown as RuntimeRequest,
        ),
      );

      expect(response?.status).toBe(401);
      expect(events).toEqual([]);
    }),
  );

  it.effect("normalizes official attachment and action events", () =>
    Effect.gen(function* () {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        return Response.json(
          isTypingRequest(body) ? { success: true } : { messages: [{ id: "wamid.reply" }] },
        );
      });
      const events: Array<MessengerEvent> = [];
      const host = new FrameworkHost(events, []);
      const channel = makeWhatsAppChannel({
        accessToken: "test-access-token",
        appSecret: APP_SECRET,
        conversation: (event) => {
          events.push(event);
          return { agentClass: OsfoAgent, name: "agent-1", target: "subagent" };
        },
        phoneNumberId: "123456789",
        userName: "osfo_test",
        verifyToken: "test-verify-token",
      });
      if (channel.ingress.transport !== "webhook") throw new Error("Expected webhook ingress");
      const { transport: _transport, ...messenger } = channel.ingress;
      const runtime = new ThinkMessengerRuntime(
        { whatsapp: messenger },
        host as unknown as MessengerThinkHost,
      );
      runtime.initialize();

      yield* Effect.promise(() =>
        runtime.handleRequest(
          request(
            payload({
              from: "15551234567",
              id: "wamid.image-1",
              image: { caption: "See this", id: "media-1", mime_type: "image/jpeg" },
              timestamp: "1786930001",
              type: "image",
            }),
          ) as unknown as RuntimeRequest,
        ),
      );
      yield* Effect.promise(() =>
        runtime.handleRequest(
          request(
            payload({
              from: "15551234567",
              id: "wamid.action-1",
              interactive: {
                button_reply: { id: "approve:yes", title: "Approve" },
                type: "button_reply",
              },
              timestamp: "1786930002",
              type: "interactive",
            }),
          ) as unknown as RuntimeRequest,
        ),
      );

      yield* Effect.promise(() =>
        vi.waitFor(() => expect(events).toHaveLength(2), { timeout: 5_000 }),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "direct-message",
            message: expect.objectContaining({
              attachments: [
                expect.objectContaining({
                  fetchMetadata: { mediaId: "media-1" },
                  mediaType: "image/jpeg",
                }),
              ],
              text: "See this",
            }),
          }),
          expect.objectContaining({
            action: expect.objectContaining({ actionId: "approve:yes", value: "approve:yes" }),
            kind: "action",
          }),
        ]),
      );
    }),
  );
});

class FrameworkHost {
  readonly name = "main";
  readonly parentPath: ReadonlyArray<{ readonly className: string; readonly name: string }> = [];
  readonly resolvedFacetNames: Array<string> = [];
  readonly #completedFibers = new Set<string>();
  readonly #state = new InMemoryChatState();
  readonly #target: FrameworkTarget;

  constructor(_events: ReadonlyArray<MessengerEvent>, modelInputs: Array<string>) {
    this.#target = new FrameworkTarget(modelInputs);
  }

  async startFiber(
    _name: string,
    run: (context: FiberContext) => Promise<void>,
    options?: { readonly idempotencyKey?: string },
  ) {
    const fiberId = options?.idempotencyKey ?? crypto.randomUUID();
    if (this.#completedFibers.has(fiberId)) {
      return { accepted: false, fiberId, status: "completed" };
    }
    let snapshot: unknown;
    await run({
      id: fiberId,
      signal: new AbortController().signal,
      snapshot: null,
      stash: (value) => {
        snapshot = value;
      },
    });
    this.#completedFibers.add(fiberId);
    return { accepted: true, fiberId, snapshot, status: "completed" };
  }

  async resolveFiber() {
    return true;
  }

  async subAgent(agentClass: { readonly name: string }, name: string) {
    if (agentClass === ThinkMessengerStateAgent) return this.#state;
    expect(agentClass).toBe(OsfoAgent);
    this.resolvedFacetNames.push(name);
    return this.#target;
  }

  chat() {
    return Promise.resolve();
  }

  cancelChat() {
    return false;
  }
}

class FrameworkTarget {
  constructor(private readonly modelInputs: Array<string>) {}

  async chatWithMessengerContext(
    message: string | { readonly parts?: ReadonlyArray<{ readonly text?: string }> },
    callback: {
      readonly onDone: () => void | Promise<void>;
      readonly onEvent: (event: string) => void | Promise<void>;
      readonly onStart: (event: { readonly requestId: string }) => void | Promise<void>;
    },
  ) {
    this.modelInputs.push(
      typeof message === "string"
        ? message
        : (message.parts ?? []).map((part) => part.text ?? "").join(""),
    );
    await callback.onStart({ requestId: "request-1" });
    await callback.onEvent(JSON.stringify({ delta: "**Hello from Osfo**", type: "text-delta" }));
    await callback.onDone();
  }

  chat() {
    return Promise.resolve();
  }

  cancelChat() {
    return false;
  }
}

class InMemoryChatState {
  readonly #cache = new Map<string, string>();
  readonly #lists = new Map<string, Array<string>>();
  readonly #locks = new Map<string, string>();
  readonly #queues = new Map<string, Array<string>>();
  readonly #subscriptions = new Set<string>();

  subscribe(threadId: string) {
    this.#subscriptions.add(threadId);
  }

  unsubscribe(threadId: string) {
    this.#subscriptions.delete(threadId);
  }

  isSubscribed(threadId: string) {
    return this.#subscriptions.has(threadId);
  }

  acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    if (this.#locks.has(threadId)) return Promise.resolve(null);
    const token = crypto.randomUUID();
    this.#locks.set(threadId, token);
    return Promise.resolve({ expiresAt: Date.now() + ttlMs, threadId, token });
  }

  releaseLock(threadId: string, token: string) {
    if (this.#locks.get(threadId) === token) this.#locks.delete(threadId);
  }

  extendLock(threadId: string, token: string) {
    return Promise.resolve(this.#locks.get(threadId) === token);
  }

  forceReleaseLock(threadId: string) {
    this.#locks.delete(threadId);
  }

  enqueue(threadId: string, value: string, maxSize: number) {
    const queue = this.#queues.get(threadId) ?? [];
    queue.push(value);
    this.#queues.set(threadId, queue.slice(-maxSize));
    return Promise.resolve(queue.length);
  }

  popQueue(threadId: string) {
    return this.#queues.get(threadId)?.shift() ?? null;
  }

  queueDepth(threadId: string) {
    return this.#queues.get(threadId)?.length ?? 0;
  }

  listAppend(key: string, value: string, maxLength?: number) {
    const list = [...(this.#lists.get(key) ?? []), value];
    this.#lists.set(key, maxLength === undefined ? list : list.slice(-maxLength));
    return Promise.resolve();
  }

  listGet(key: string) {
    return this.#lists.get(key) ?? [];
  }

  cacheGet(key: string) {
    return this.#cache.get(key) ?? null;
  }

  cacheSet(key: string, value: string) {
    this.#cache.set(key, value);
    return Promise.resolve();
  }

  cacheSetIfNotExists(key: string, value: string) {
    if (this.#cache.has(key)) return Promise.resolve(false);
    this.#cache.set(key, value);
    return Promise.resolve(true);
  }

  cacheDelete(key: string) {
    this.#cache.delete(key);
  }
}

interface Lock {
  readonly expiresAt: number;
  readonly threadId: string;
  readonly token: string;
}

type RuntimeRequest = Parameters<ThinkMessengerRuntime["handleRequest"]>[0];

const APP_SECRET = "test-app-secret";
const payload = (message: Record<string, unknown>) => ({
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            contacts: [{ profile: { name: "Test User" }, wa_id: "15551234567" }],
            messages: [message],
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "14165550100",
              phone_number_id: "123456789",
            },
          },
        },
      ],
      id: "waba-1",
    },
  ],
  object: "whatsapp_business_account",
});

const whatsAppPayload = payload({
  from: "15551234567",
  id: "wamid.inbound-1",
  text: { body: "Hello from WhatsApp" },
  timestamp: "1786930000",
  type: "text",
});

const request = (input: unknown) => {
  const body = JSON.stringify(input);
  return new Request("https://osfo.test/webhooks/whatsapp", {
    body,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`,
    },
    method: "POST",
  });
};

const isTypingRequest = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  return "status" in value && value.status === "read" && "typing_indicator" in value;
};
