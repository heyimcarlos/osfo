import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";

import { AgentId, UserId } from "../src/domain";
import { RegistrationCloudflare } from "../src/integrations/cloudflare/registration";
import { Registration } from "../src/services/registration";

describe("Cloudflare Agent registration", () => {
  it.effect("retries the same stable Agent initialization after an RPC rejection", () => {
    const initializations: Array<{
      readonly agentId: string;
      readonly initializationId: string;
      readonly routeId: string;
      readonly sessionId: string;
    }> = [];
    const env: RegistrationCloudflare.Bindings = {
      OSFO_DIRECTORY: {
        getByName: () => ({
          ensureAgent: (agentId) => Promise.resolve({ className: "OsfoAgent", name: agentId }),
          initializeAgent: (_agentId, input) => {
            initializations.push(input);
            return Promise.resolve({
              _tag:
                initializations.length === 1 ? "AgentInitializationRejected" : "AgentInitialized",
            });
          },
        }),
      },
    };
    const registration = Registration.RegistrationCompleted.make({
      agentId: AgentId.make("agent-registration-retry"),
      completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-21T05:00:00.000Z")),
      userId: UserId.make("user-registration-retry"),
    });

    return Effect.gen(function* () {
      const port = yield* Registration.AgentRegistration;
      const rejected = yield* port.initialize(registration).pipe(Effect.flip);
      yield* port.initialize(registration);

      expect(rejected).toMatchObject({ _tag: "RegistrationAgentUnavailable" });
      expect(initializations).toHaveLength(2);
      expect(initializations[0]).toEqual(initializations[1]);
      expect(initializations[1]).toMatchObject({
        agentId: registration.agentId,
        initializationId: `registration-${registration.agentId}`,
        routeId: `primary-route-${registration.agentId}`,
        sessionId: `primary-session-${registration.agentId}`,
      });
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The test owns this complete adapter entry-point Layer.
      Effect.provide(RegistrationCloudflare.layer(env)),
    );
  });
});
