import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";

import { AgentId, UserId } from "../src/domain";
import { OnboardingCloudflare } from "../src/integrations/cloudflare/onboarding";
import { Onboarding } from "../src/services/onboarding";

/* oxlint-disable effecttsgo/strict-effect-provide -- This focused integration test is the Layer entry point. */

describe("Cloudflare onboarding adapter", () => {
  it.effect("mints a provider-neutral primary Conversation Route for a new Agent", () => {
    const lifecycle: Array<string> = [];
    const routeIds: Array<string> = [];
    const layer = OnboardingCloudflare.layer({
      OSFO_DIRECTORY: {
        getByName: () => ({
          commitAgentWelcome: () => Promise.resolve({ _tag: "PersonalWelcomeCommitted" }),
          initializeAgent: (_agentId, input) => {
            lifecycle.push("initialize");
            routeIds.push(input.routeId);
            return Promise.resolve({ _tag: "AgentInitialized" });
          },
          ensureAgent: (agentId) => {
            lifecycle.push("ensure");
            return Promise.resolve({ className: "OsfoAgent", name: agentId });
          },
        }),
      },
      REGISTRATION_DIALOGUE: {
        getByName: () => ({
          deleteDialogue: () => Promise.resolve(),
        }),
      },
    });

    return Onboarding.AgentOnboarding.pipe(
      Effect.flatMap((agent) =>
        agent.initialize({
          agentId: AgentId.make("agent-new-provider-neutral-route"),
          completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-17T00:00:00.000Z")),
          userId: UserId.make("user-new-provider-neutral-route"),
        }),
      ),
      Effect.andThen(
        Effect.sync(() => {
          expect(lifecycle).toEqual(["ensure", "initialize"]);
          expect(routeIds).toEqual(["primary-route-agent-new-provider-neutral-route"]);
        }),
      ),
      Effect.provide(layer),
    );
  });
});
