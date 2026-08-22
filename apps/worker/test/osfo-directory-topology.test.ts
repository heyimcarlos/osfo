import { env } from "cloudflare:workers";
import type { StreamCallback } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { getAgentByName, getSubAgentByName } from "agents";
import { Effect, Layer } from "effect";

import { OsfoAgent } from "../src/agents/osfo/agent";
import { CompanyAgent, companyAddressKey } from "../src/agents/osfo/company-agent";
import { OSFO_DIRECTORY_NAME, replyToDirectoryGate } from "../src/agents/osfo/directory";
import {
  makeOsfoMessengerRouter,
  type OsfoMessengerRoutingOptions,
} from "../src/agents/osfo/messenger-routing";
import { UserId } from "../src/domain";
import { ChannelLinks } from "../src/services/channel-links";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/strict-effect-provide, typescript/consistent-return -- Cloudflare Agent test helpers expose Promise boundaries, tests are Effect entry points with local Layers, Channel Link fixtures use JavaScript Dates, and Effect generators use typed early failure. */

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
      const boundRouting = routingForRegistry(registry);
      const telegramTarget = yield* Effect.promise(() =>
        Promise.resolve(boundRouting(telegramEvent)),
      );
      const telegramTargetState = yield* Effect.promise(() => directory.inspectAgent(firstAgentId));
      const whatsAppTarget = yield* Effect.promise(() =>
        Promise.resolve(boundRouting(whatsAppEvent)),
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
      expect(telegramTarget).toMatchObject({ agentClass: OsfoAgent, target: "subagent" });
      expect(whatsAppTarget).toMatchObject({ agentClass: OsfoAgent, target: "subagent" });
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

  it.effect("routes unlinked direct-message senders to opaque address-keyed facets", () =>
    Effect.gen(function* () {
      const routing = makeOsfoMessengerRouter(unboundRouting);
      const first = yield* Effect.promise(() => Promise.resolve(routing(telegramEvent)));
      const repeat = yield* Effect.promise(() => Promise.resolve(routing(telegramEvent)));
      const otherAuthor = yield* Effect.promise(() =>
        Promise.resolve(routing(withTelegramAuthor(telegramEvent, "telegram-user-2"))),
      );
      const expectedKey = yield* companyAddressKey(telegramEvent.messengerId, "telegram-user-1");
      const otherKey = yield* companyAddressKey(telegramEvent.messengerId, "telegram-user-2");

      expect(first).toEqual({ agentClass: CompanyAgent, name: expectedKey, target: "subagent" });
      expect(repeat).toEqual(first);
      expect(otherAuthor).toEqual({
        agentClass: CompanyAgent,
        name: otherKey,
        target: "subagent",
      });
      expect(expectedKey).not.toContain("telegram-user-1");
      expect(expectedKey).toMatch(/^company-[0-9a-f]{32}$/);
    }),
  );

  it.effect("keeps group events on the dormant directory without any binding lookup", () =>
    Effect.gen(function* () {
      let bindingLookups = 0;
      const routing = makeOsfoMessengerRouter({
        ...unboundRouting,
        resolveAddress: () => {
          bindingLookups += 1;
          return Effect.succeed({ _tag: "Unlinked" });
        },
      });

      const group = yield* Effect.promise(() =>
        Promise.resolve(routing(groupEvent(telegramEvent))),
      );

      expect(group).toEqual({ target: "self" });
      expect(bindingLookups).toBe(0);
    }),
  );

  it.effect(
    "keeps unavailable authority and missing personal facets on the dormant directory",
    () =>
      Effect.gen(function* () {
        const missingFacetRouting = makeOsfoMessengerRouter({
          hasAgent: () => false,
          resolveAddress: () => Effect.succeed({ _tag: "Linked", agentId: "agent-topology-first" }),
        });
        const unavailableRouting = makeOsfoMessengerRouter({
          hasAgent: () => true,
          resolveAddress: () => Effect.succeed({ _tag: "Unavailable" }),
        });
        const whatsappRouting = makeOsfoMessengerRouter({
          hasAgent: () => false,
          resolveAddress: () => Effect.succeed({ _tag: "Unlinked" }),
        });

        const telegramUnreachable = yield* Effect.promise(() =>
          Promise.resolve(missingFacetRouting(telegramEvent)),
        );
        const authorityUnavailable = yield* Effect.promise(() =>
          Promise.resolve(unavailableRouting(telegramEvent)),
        );
        const whatsappUnlinked = yield* Effect.promise(() =>
          Promise.resolve(whatsappRouting(whatsAppEvent)),
        );

        expect(telegramUnreachable).toEqual({ target: "self" });
        expect(authorityUnavailable).toEqual({ target: "self" });
        expect(whatsappUnlinked).toMatchObject({ target: "subagent" });
      }),
  );

  it.effect("refuses group linking deterministically at the directory gate", () =>
    Effect.gen(function* () {
      let linkReads = 0;
      const reply = makeStreamRecorder();

      yield* replyToDirectoryGate(reply.callback, groupEvent(telegramEvent)).pipe(
        Effect.provide(
          channelLinksLayer(() =>
            Effect.sync(() => {
              linkReads += 1;
              return null;
            }),
          ),
        ),
      );

      expect(linkReads).toBe(0);
      expect(reply.text()).toContain("Message Osfo privately");
      expect(reply.text()).toContain("Escríbele a Osfo por privado");
      expect(reply.text()).not.toContain("/verify/");
    }),
  );

  it.effect("answers a linked but unreachable channel without a model turn", () =>
    Effect.gen(function* () {
      const reply = makeStreamRecorder();

      yield* replyToDirectoryGate(reply.callback, telegramEvent).pipe(
        Effect.provide(channelLinksLayer(() => Effect.succeed(linkedChannel))),
      );

      expect(reply.text()).toContain("This channel is linked");
    }),
  );
});

const unboundRouting: OsfoMessengerRoutingOptions = {
  hasAgent: () => false,
  resolveAddress: () => Effect.succeed({ _tag: "Unlinked" }),
};

const routingForRegistry = (registry: ReadonlyArray<{ readonly name: string }>) =>
  makeOsfoMessengerRouter({
    hasAgent: (name) => registry.some((entry) => entry.name === name),
    resolveAddress: () => Effect.succeed({ _tag: "Linked", agentId: "agent-topology-first" }),
  });

const channelLinksLayer = (resolve: ChannelLinks.Interface["resolve"]) =>
  Layer.mock(ChannelLinks.Service, { resolve });

const linkedChannel = ChannelLinks.ChannelLink.make({
  address: ChannelLinks.ChannelAddress.make({
    authorId: ChannelLinks.ChannelAuthorId.make("telegram-user-1"),
    channelId: ChannelLinks.ChannelId.make("telegram"),
  }),
  channelLinkId: ChannelLinks.ChannelLinkId.make("channel-link-topology"),
  createdAt: new Date("2026-08-21T12:00:00.000Z"),
  revokedAt: null,
  userId: UserId.make("user-topology"),
});

const groupEvent = (event: typeof telegramEvent) => ({
  ...event,
  kind: "mention" as const,
  thread: { ...event.thread, isDirectMessage: false },
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
