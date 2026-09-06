/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, vitest/no-standalone-expect -- This journey drives the native WebSocket and inspects its PostgreSQL-backed Agent inside Effect. */
import { expect, it } from "@effect/vitest";
import { validateUIMessages } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { CHAT_MESSAGE_TYPES } from "agents/chat";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";
import { vi } from "vitest";

import { OsfoAgent } from "../../src/agents/osfo/agent";
import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
import { Db } from "../../src/db";
import { IncidentControlsPostgres } from "../../src/integrations/postgres/incident-controls";
import { spawnApp } from "../support/spawn-app";

const encodeWire = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const WireMessage = Schema.Struct({
  type: Schema.String,
  id: Schema.optionalKey(Schema.String),
  probeId: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  done: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.Boolean),
});

it.effect(
  "pauses new messages on an authenticated connected socket while preserving cancellation and recovery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
          Effect.promise(client.dispose),
        );
        const identity = yield* Effect.promise(() => app.auth.mintVerifiedUser());
        const database = yield* Db.database;
        const controls = IncidentControlsPostgres.makeFromDatabase(database);
        const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
        let aborted = false;
        const dispatch = vi.fn<MockLanguageModelV4["doStream"]>(async (options) => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "accepted-answer" });
              controller.enqueue({ type: "text-delta", id: "accepted-answer", delta: "Accepted" });
              options.abortSignal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  controller.close();
                },
                { once: true },
              );
            },
          }),
        }));
        const model = new MockLanguageModelV4({ doStream: dispatch });
        vi.spyOn(OsfoAgent.prototype, "resolveModel").mockReturnValue(model);
        vi.spyOn(OsfoAgent.prototype, "beforeTurn").mockResolvedValue({
          model,
          tools: {},
          maxSteps: 1,
        });
        // Inspect native Session storage through the existing RPC instead of its in-memory cache.
        vi.spyOn(OsfoAgent.prototype, "getMessages").mockImplementation(
          async function (this: OsfoAgent) {
            return validateUIMessages({ messages: await this.session.getHistory() });
          },
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.restoreAllMocks()));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            runInDurableObject(directory, async (owner) => {
              const agent = await owner.subAgent(OsfoAgent, identity.agentId);
              await agent.cancelChat("accepted-request");
            }),
          ),
        );
        const history = yield* Effect.promise(() => app.fetch("/agent/get-messages"));
        expect(history.status).toBe(200);
        expect(yield* Effect.promise(() => history.json())).toEqual([]);
        const response = yield* Effect.promise(() =>
          app.fetch("/agent/?_cf_connectionId=incident-socket", {
            headers: { upgrade: "websocket" },
          }),
        );
        expect(response.status).toBe(101);
        const socket = response.webSocket;
        if (socket === null)
          return yield* Effect.die(new Error("Authenticated WebSocket was not accepted"));
        socket.accept();
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
        const accepted = nextMessage(
          socket,
          (message) =>
            message.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE &&
            message.id === "accepted-request" &&
            message.body?.includes("Accepted") === true,
        );
        socket.send(chatRequest("accepted-request", "accepted-message"));
        yield* Effect.promise(() => accepted);
        expect(dispatch).toHaveBeenCalledOnce();
        const before = yield* Effect.promise(() =>
          runInDurableObject(directory, async (owner) => {
            const agent = await owner.subAgent(OsfoAgent, identity.agentId);
            return {
              messages: await agent.getMessages(),
              submissions: await agent.listSubmissions(),
            };
          }),
        );
        expect(before.messages.some((message) => message.id === "accepted-message")).toBe(true);
        yield* controls.set({
          control: "newIngress",
          paused: true,
          actor: "journey",
          reason: "Connected message admission",
        });
        const refused = nextMessage(
          socket,
          (message) => message.id === "refused-request" && message.done === true,
        );
        socket.send(chatRequest("refused-request", "refused-message"));
        expect(yield* Effect.promise(() => refused)).toMatchObject({ error: true, done: true });
        const after = yield* Effect.promise(() =>
          runInDurableObject(directory, async (owner) => {
            const agent = await owner.subAgent(OsfoAgent, identity.agentId);
            return {
              messages: await agent.getMessages(),
              submissions: await agent.listSubmissions(),
            };
          }),
        );
        expect(after).toEqual(before);
        expect(dispatch).toHaveBeenCalledOnce();
        const resumed = nextMessage(
          socket,
          (message) =>
            message.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING &&
            message.probeId === "during-pause",
        );
        socket.send(
          encodeWire({
            type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
            probeId: "during-pause",
          }),
        );
        expect(yield* Effect.promise(() => resumed)).toMatchObject({ id: "accepted-request" });
        socket.send(
          encodeWire({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: "accepted-request" }),
        );
        socket.send(
          encodeWire({ type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL, id: "accepted-request" }),
        );
        yield* Effect.promise(() => vi.waitFor(() => expect(aborted).toBe(true)));
        expect(dispatch).toHaveBeenCalledOnce();
        return undefined;
      }).pipe(Effect.provide(Db.layer({ db: env.DB }))),
    ),
);

const chatRequest = (requestId: string, messageId: string) =>
  encodeWire({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
    id: requestId,
    init: {
      method: "POST",
      body: encodeWire({
        messages: [
          { id: messageId, role: "user", parts: [{ type: "text", text: "A connected request" }] },
        ],
      }),
    },
  });

/* oxlint-disable effecttsgo/new-promise, effecttsgo/global-timers -- This native WebSocket callback adapter owns its timeout and listener cleanup. */
const nextMessage = (socket: WebSocket, matches: (message: typeof WireMessage.Type) => boolean) =>
  new Promise<typeof WireMessage.Type>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", receive);
      reject(new Error("Expected WebSocket protocol response was not received"));
    }, 5_000);
    const receive = (event: MessageEvent) => {
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(WireMessage))(event.data);
      if (Option.isSome(decoded) && matches(decoded.value)) {
        clearTimeout(timeout);
        socket.removeEventListener("message", receive);
        resolve(decoded.value);
      }
    };
    socket.addEventListener("message", receive);
  });
