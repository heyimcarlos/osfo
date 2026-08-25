/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { spawnApp } from "../support/spawn-app";

it.effect("deletes a registered User through the authenticated Worker endpoint", () =>
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
      Effect.promise(client.dispose),
    );
    yield* Effect.promise(() => app.auth.sendPhoneOtp("+15550001920"));
    yield* Effect.promise(() => app.auth.verifyPhoneOtp("+15550001920", "424242"));
    const registration = yield* Effect.promise(() =>
      app.registration.complete({ helpAreas: [], locale: "en", preferredName: "Delete Me" }),
    );
    const identity = yield* registration.body === undefined
      ? Effect.die(new Error("Registration did not return an identity"))
      : Effect.succeed(registration.body);
    const seededProvider = yield* Effect.promise(() => app.supermemory.seedUser(identity.userId));
    const unrelatedProvider = yield* Effect.promise(() =>
      app.supermemory.seedUser("unrelated-user-for-account-deletion"),
    );
    const expectedContainers = [seededProvider.containerTag, unrelatedProvider.containerTag];
    // oxlint-disable-next-line unicorn/no-array-sort -- The Worker target lacks ES2023 toSorted; this local array is fresh.
    expectedContainers.sort();
    expect(yield* Effect.promise(app.supermemory.containers)).toEqual(expectedContainers);

    const response = yield* Effect.promise(app.account.delete);
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ status: "deletion-pending" });
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toEqual({
      agent_exists: false,
      auth_session_exists: false,
      deletion_case_exists: false,
      user_exists: false,
    });
    expect(yield* Effect.promise(app.supermemory.ledger)).toEqual([
      {
        method: "DELETE",
        path: expect.stringMatching(/^\/v3\/container-tags\/u_[A-Za-z0-9_-]+$/u),
      },
    ]);
    expect(yield* Effect.promise(app.supermemory.containers)).toEqual([
      unrelatedProvider.containerTag,
    ]);

    const session = yield* Effect.promise(app.auth.session);
    expect(session.status).toBe(200);
    expect(yield* Effect.promise(() => session.json())).toBeNull();
  }),
);
