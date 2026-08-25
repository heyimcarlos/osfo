import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { spawnApp } from "../support/spawn-app";

it.effect("registers a new User through SMS and provisions the committed free account", () =>
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
      Effect.promise(client.dispose),
    );
    const identity = yield* Effect.promise(() =>
      app.auth.mintVerifiedUser({
        profile: {
          helpAreas: ["research", "files-documents"],
          locale: "en",
          preferredName: "Ada",
        },
      }),
    );

    const session = yield* Effect.promise(app.auth.session);
    expect(session.status).toBe(200);
    expect(yield* Effect.promise(() => session.json())).toMatchObject({
      user: { phoneNumber: identity.phoneNumber },
    });
    expect(identity).toMatchObject({
      agentId: expect.stringMatching(/^agent-/u),
      completedAt: expect.any(String),
      phoneNumber: expect.stringMatching(/^\+1555\d{7}$/u),
      userId: expect.any(String),
    });

    const registration = yield* Effect.promise(() => app.database.registration(identity.userId));
    expect(registration).toMatchObject({
      agent_id: identity.agentId,
      allowance_plan: "free",
      billing_plan: "free",
      help_areas: ["research", "files-documents"],
      locale: "en",
      phone_number_verified: true,
      preferred_name: "Ada",
      registration_completed_at: expect.any(Date),
    });
    const twilio = yield* Effect.promise(app.twilio.ledger);
    expect(twilio).toEqual([
      expect.objectContaining({
        code: null,
        path: expect.stringMatching(/\/Verifications$/u),
        to: identity.phoneNumber,
      }),
      expect.objectContaining({
        code: "424242",
        path: expect.stringMatching(/\/VerificationCheck$/u),
        to: identity.phoneNumber,
      }),
    ]);
  }),
);
