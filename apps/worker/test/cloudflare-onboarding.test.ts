import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";

import { AgentId, UserId } from "../src/domain";
import * as OnboardingCloudflare from "../src/integrations/cloudflare/onboarding";
import * as Onboarding from "../src/services/onboarding";

/* oxlint-disable effecttsgo/strict-effect-provide -- This focused integration test is the Layer entry point. */

describe("Cloudflare onboarding adapter", () => {
  it.effect("mints a provider-neutral primary Conversation Route for a new Agent", () => {
    const routeIds: Array<string> = [];
    const layer = OnboardingCloudflare.layer({
      OSFO_AGENT: {
        getByName: () => ({
          commitWelcome: () => Promise.resolve({ _tag: "PersonalWelcomeCommitted" }),
          initialize: (input) => {
            routeIds.push(input.routeId);
            return Promise.resolve({ _tag: "AgentInitialized" });
          },
        }),
      },
      REGISTRATION_DIALOGUE: {
        getByName: () => ({
          begin: () =>
            Promise.resolve({
              _tag: "RegistrationTurnCompleted",
              response: "Continue registration.",
              verifyUrl: "https://osfo.ai/verify/test",
            }),
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
        Effect.sync(() =>
          expect(routeIds).toEqual(["primary-route-agent-new-provider-neutral-route"]),
        ),
      ),
      Effect.provide(layer),
    );
  });

  it.effect("preserves a legacy canonical route when existing-Agent initialization retries", () => {
    const routeIds: Array<string> = [];
    const layer = OnboardingCloudflare.layer({
      OSFO_AGENT: {
        getByName: () => ({
          commitWelcome: () => Promise.resolve({ _tag: "PersonalWelcomeCommitted" }),
          initialize: (input) => {
            routeIds.push(input.routeId);
            return Promise.resolve({
              _tag:
                input.routeId === "whatsapp-route-agent-existing-legacy-route"
                  ? "AgentInitialized"
                  : "AgentInitializationConflict",
            });
          },
        }),
      },
      REGISTRATION_DIALOGUE: {
        getByName: () => ({
          begin: () =>
            Promise.resolve({
              _tag: "RegistrationTurnCompleted",
              response: "Continue registration.",
              verifyUrl: "https://osfo.ai/verify/test",
            }),
          deleteDialogue: () => Promise.resolve(),
        }),
      },
    });

    return Onboarding.AgentOnboarding.pipe(
      Effect.flatMap((agent) =>
        agent.initialize({
          agentId: AgentId.make("agent-existing-legacy-route"),
          completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-17T00:00:00.000Z")),
          userId: UserId.make("user-existing-legacy-route"),
        }),
      ),
      Effect.andThen(
        Effect.sync(() =>
          expect(routeIds).toEqual([
            "primary-route-agent-existing-legacy-route",
            "whatsapp-route-agent-existing-legacy-route",
          ]),
        ),
      ),
      Effect.provide(layer),
    );
  });
});
