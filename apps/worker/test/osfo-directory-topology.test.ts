import { env } from "cloudflare:workers";
import type { StreamCallback } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { getAgentByName, getSubAgentByName } from "agents";
import { DateTime, Effect, Exit } from "effect";

import { OsfoAgent } from "../src/agents/osfo/agent";
import { OSFO_DIRECTORY_NAME, replyToChannelLinkMessenger } from "../src/agents/osfo/directory";
import { ChannelLinks } from "../src/services/channel-links";
import { makeTelegramConversationResolver } from "../src/integrations/telegram";
import { makeWhatsAppConversationResolver } from "../src/integrations/whatsapp";

/* oxlint-disable effecttsgo/async-function, typescript/consistent-return -- Cloudflare Agent test helpers expose Promise boundaries, and Effect generators use typed early failure. */

describe("Osfo directory topology", () => {
  it.effect("keeps stable and isolated user-owned Osfo Agent facets", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        getAgentByName(env.OSFO_DIRECTORY, OSFO_DIRECTORY_NAME),
      );
      const firstAgentId = "agent-topology-first";
      const secondAgentId = "agent-topology-second";

      const firstResolution = yield* Effect.promise(() => directory.ensureAgent(firstAgentId));
      const repeatedResolution = yield* Effect.promise(() => directory.ensureAgent(firstAgentId));
      yield* Effect.promise(() =>
        directory.initializeAgent(firstAgentId, {
          agentId: firstAgentId,
          initializationId: "init-topology-first",
          initializedAt: "2026-08-17T12:00:00.000Z",
          routeId: "route-topology-first",
          sessionId: "session-topology-first",
        }),
      );
      yield* Effect.promise(() =>
        directory.initializeAgent(secondAgentId, {
          agentId: secondAgentId,
          initializationId: "init-topology-second",
          initializedAt: "2026-08-17T12:00:00.000Z",
          routeId: "route-topology-second",
          sessionId: "session-topology-second",
        }),
      );

      const webFacet = yield* Effect.promise(() =>
        getSubAgentByName(directory, OsfoAgent, firstAgentId),
      );
      const webState = yield* Effect.promise(() => webFacet.inspect());
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Effect tagged unions use `_tag`.
      if (webState._tag !== "AgentFound") {
        return yield* Effect.die(new Error("The web facet marker is missing"));
      }
      const registry = yield* Effect.promise(() => directory.listAgents());
      const telegramResolver = makeTelegramConversationResolver({
        agentClass: OsfoAgent,
        hasAgent: (agentId) => registry.some(({ name }) => name === agentId),
        isAllowed: (authorId) => authorId === "telegram-user-1",
        resolveAgentId: () => Promise.resolve(firstAgentId),
      });
      const telegramTarget = yield* Effect.promise(() =>
        Promise.resolve(telegramResolver(telegramEvent)),
      );
      const telegramTargetState = yield* Effect.promise(() => directory.inspectAgent(firstAgentId));
      const whatsAppResolver = makeWhatsAppConversationResolver({
        agentClass: OsfoAgent,
        hasAgent: (agentId) => registry.some(({ name }) => name === agentId),
        resolveAgentId: () => Promise.resolve(firstAgentId),
      });
      const whatsAppTarget = yield* Effect.promise(() =>
        Promise.resolve(whatsAppResolver(whatsAppEvent)),
      );
      const whatsAppTargetState = yield* Effect.promise(() => directory.inspectAgent(firstAgentId));
      const secondState = yield* Effect.promise(() => directory.inspectAgent(secondAgentId));

      expect(firstResolution).toEqual({ className: "OsfoAgent", name: firstAgentId });
      expect(repeatedResolution).toEqual(firstResolution);
      expect(registry.filter(({ name }) => name === firstAgentId)).toHaveLength(1);
      expect(webState).toMatchObject({
        agentId: firstAgentId,
        currentSessionId: "session-topology-first",
      });
      expect(telegramTarget).toMatchObject({ name: firstAgentId, target: "subagent" });
      expect(whatsAppTarget).toMatchObject({ name: firstAgentId, target: "subagent" });
      expect(telegramTargetState).toMatchObject({
        agentId: webState.agentId,
        currentSessionId: webState.currentSessionId,
        routeId: webState.routeId,
      });
      expect(whatsAppTargetState).toEqual(telegramTargetState);
      expect(secondState).toMatchObject({
        agentId: secondAgentId,
        currentSessionId: "session-topology-second",
      });
      expect(secondState).not.toEqual(webState);
    }),
  );

  it.effect("rejects unknown facet routes without creating them", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(
        async () => await getAgentByName(env.OSFO_DIRECTORY, OSFO_DIRECTORY_NAME),
      );
      const response = yield* Effect.promise(() =>
        directory.fetch(
          new Request("https://osfo.test/sub/osfo-agent/agent-topology-unknown", {
            method: "GET",
          }),
        ),
      );

      expect(response.status).toBe(404);
      expect(yield* Effect.promise(() => response.text())).toBe("Agent not found");
      expect(
        yield* Effect.promise(() => directory.inspectAgent("agent-topology-unknown")),
      ).toBeNull();
    }),
  );

  it.effect("keeps unauthorized and unbound Telegram authors on the dormant directory", () =>
    Effect.gen(function* () {
      let bindingLookups = 0;
      const resolver = makeTelegramConversationResolver({
        agentClass: OsfoAgent,
        hasAgent: () => true,
        isAllowed: (authorId) => authorId !== "telegram-blocked",
        resolveAgentId: () => {
          bindingLookups += 1;
          return Promise.resolve(null);
        },
      });

      const blocked = yield* Effect.promise(() =>
        Promise.resolve(resolver(withTelegramAuthor(telegramEvent, "telegram-blocked"))),
      );
      const unbound = yield* Effect.promise(() =>
        Promise.resolve(resolver(withTelegramAuthor(telegramEvent, "telegram-unbound"))),
      );

      expect(blocked).toEqual({ target: "self" });
      expect(unbound).toEqual({ target: "self" });
      expect(bindingLookups).toBe(1);
    }),
  );

  it.effect("uses only the normalized Messenger Context address", () =>
    Effect.gen(function* () {
      const resolved: Array<readonly [string, string]> = [];
      const resolver = makeTelegramConversationResolver({
        agentClass: OsfoAgent,
        hasAgent: () => true,
        isAllowed: () => true,
        resolveAgentId: (authorId, messengerId) => {
          resolved.push([authorId, messengerId]);
          return Promise.resolve(null);
        },
      });

      const { author: omittedAuthor, ...withoutNormalizedAuthor } = telegramEvent;
      expect(omittedAuthor.userId).toBe("telegram-user-1");
      expect(
        yield* Effect.promise(() => Promise.resolve(resolver(withoutNormalizedAuthor))),
      ).toEqual({ target: "self" });
      expect(yield* Effect.promise(() => Promise.resolve(resolver(telegramEvent)))).toEqual({
        target: "self",
      });
      expect(resolved).toEqual([["telegram-user-1", "telegram"]]);
    }),
  );

  it.effect("delivers a private invite without beginning a privileged model turn", () =>
    Effect.gen(function* () {
      const ensuredAddresses: Array<typeof ChannelLinks.ChannelAddress.Type> = [];
      const reply = makeStreamRecorder();

      yield* Effect.promise(() =>
        replyToChannelLinkMessenger(reply.callback, telegramEvent, {
          ensure: (address) => {
            ensuredAddresses.push(address);
            return Promise.resolve(
              Exit.succeed({
                _tag: "Invited" as const,
                expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-22T12:00:00.000Z")),
                verificationUrl: new URL("https://osfo.test/verify/private.claims"),
              }),
            );
          },
          telegramAllowedUserIds: new Set(["telegram-user-1"]),
        }),
      );

      expect(ensuredAddresses).toEqual([
        ChannelLinks.ChannelAddress.make({
          authorId: ChannelLinks.ChannelAuthorId.make("telegram-user-1"),
          channelId: ChannelLinks.ChannelId.make("telegram"),
        }),
      ]);
      expect(reply.text()).toContain("https://osfo.test/verify/private.claims");
    }),
  );

  it.effect("refuses group linking without creating or exposing an invitation", () =>
    Effect.gen(function* () {
      let ensureCalls = 0;
      const reply = makeStreamRecorder();

      yield* Effect.promise(() =>
        replyToChannelLinkMessenger(
          reply.callback,
          {
            ...telegramEvent,
            kind: "mention",
            thread: { ...telegramEvent.thread, isDirectMessage: false },
          },
          {
            ensure: () => {
              ensureCalls += 1;
              return Promise.resolve(Exit.die(new Error("Group linking must remain gated")));
            },
            telegramAllowedUserIds: new Set(["telegram-user-1"]),
          },
        ),
      );

      expect(ensureCalls).toBe(0);
      expect(reply.text()).toContain("Message Osfo privately");
      expect(reply.text()).not.toContain("/verify/");
    }),
  );
});

const makeStreamRecorder = () => {
  const events: Array<string> = [];
  const callback = {
    onDone: () => undefined,
    onError: () => undefined,
    onEvent: (event: string) => {
      events.push(event);
    },
    onStart: () => undefined,
  } satisfies StreamCallback;
  return {
    callback,
    text: () => events.join("\n"),
  };
};

const withTelegramAuthor = (event: typeof telegramEvent, userId: string) => ({
  ...event,
  author: { userId },
  message: { ...event.message, author: { userId } },
});

const telegramEvent = {
  author: { userId: "telegram-user-1" },
  capabilities: {},
  kind: "direct-message" as const,
  message: {
    attachments: [],
    author: { userId: "telegram-user-1" },
    id: "telegram-message-1",
    providerMessageId: "telegram-message-1",
    text: "Read the web marker",
  },
  messengerId: "telegram",
  provider: "telegram",
  thread: {
    id: "telegram-thread-1",
    isDirectMessage: true,
    providerThreadId: "telegram-thread-1",
  },
};

const whatsAppEvent = {
  ...telegramEvent,
  author: { userId: "15551234567" },
  message: {
    ...telegramEvent.message,
    author: { userId: "15551234567" },
    id: "wamid.topology-1",
    providerMessageId: "wamid.topology-1",
  },
  messengerId: "whatsapp",
  provider: "whatsapp",
  thread: {
    id: "whatsapp:123456789:15551234567",
    isDirectMessage: true,
    providerThreadId: "whatsapp:123456789:15551234567",
  },
};
