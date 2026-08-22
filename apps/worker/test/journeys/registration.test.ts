import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { spawnApp } from "../support/spawn-app";

it.effect("registers a new User through SMS and provisions the committed free account", () =>
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
      Effect.promise(client.dispose),
    );
    const phoneNumber = "+15550001234";

    const sent = yield* Effect.promise(() => app.auth.sendPhoneOtp(phoneNumber));
    expect(sent.status).toBe(200);

    const verified = yield* Effect.promise(() => app.auth.verifyPhoneOtp(phoneNumber, "424242"));
    expect(verified.status).toBe(200);

    const session = yield* Effect.promise(app.auth.session);
    expect(session.status).toBe(200);
    expect(yield* Effect.promise(() => session.json())).toMatchObject({
      user: { phoneNumber },
    });

    const completed = yield* Effect.promise(() =>
      app.registration.complete({
        helpAreas: ["research", "files-documents"],
        locale: "en",
        preferredName: "Ada",
      }),
    );
    expect(completed.response.status).toBe(200);
    expect(completed.body).toMatchObject({
      agentId: expect.stringMatching(/^agent-/u),
      completedAt: expect.any(String),
      userId: expect.any(String),
    });
    const identity = yield* completed.body === undefined
      ? Effect.die(new Error("Missing identity"))
      : Effect.succeed(completed.body);

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
        to: phoneNumber,
      }),
      expect.objectContaining({
        code: "424242",
        path: expect.stringMatching(/\/VerificationCheck$/u),
        to: phoneNumber,
      }),
    ]);
  }),
);
