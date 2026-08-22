import type { MessengerEvent } from "@cloudflare/think/messengers";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { CompanyAgent } from "../../src/agents/osfo/company-agent";
import { makeOsfoMessengerRouter } from "../../src/agents/osfo/messenger-routing";

describe("Osfo messenger routing", () => {
  it.effect("routes an unlinked direct-message author to a Company Conversation", () =>
    Effect.gen(function* () {
      const event = {
        capabilities: {},
        kind: "direct-message",
        message: {
          attachments: [],
          author: { userId: "telegram-user-1" },
          id: "telegram-user-1:message-1",
          providerMessageId: "message-1",
          text: "Hello",
        },
        messengerId: "telegram",
        provider: "telegram",
        thread: {
          id: "telegram:telegram-user-1",
          isDirectMessage: true,
          providerThreadId: "telegram-user-1",
        },
      } satisfies MessengerEvent;
      const route = yield* Effect.promise(() =>
        Promise.resolve(
          makeOsfoMessengerRouter({
            hasAgent: () => false,
            resolveAddress: () =>
              Effect.succeed({ _tag: "Unlinked" as const, previousChannelLinkId: null }),
          })(event),
        ),
      );

      expect(route).toMatchObject({
        agentClass: CompanyAgent,
        target: "subagent",
      });
    }),
  );
});
