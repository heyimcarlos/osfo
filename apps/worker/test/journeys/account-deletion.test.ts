/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
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
    const targetR2Key = `users/${encodeURIComponent(identity.userId)}/trusted-evidence/account-deletion-journey.txt`;
    const unrelatedR2Key =
      "users/unrelated-user-for-account-deletion/trusted-evidence/sentinel.txt";
    yield* Effect.promise(() => env.FILES.put(targetR2Key, "target"));
    yield* Effect.promise(() => env.FILES.put(unrelatedR2Key, "unrelated"));
    const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
    expect(yield* Effect.promise(() => directory.inspectAgent(identity.agentId))).not.toBeNull();
    expect(yield* Effect.promise(() => env.FILES.head(targetR2Key))).not.toBeNull();
    expect(yield* Effect.promise(() => env.FILES.head(unrelatedR2Key))).not.toBeNull();

    const presented = yield* Effect.promise(app.account.present);
    expect(presented.response.status).toBe(200);
    if (presented.body === undefined) {
      return yield* Effect.die(new Error("Account deletion was not presented"));
    }
    const presentation = presented.body;
    const staleApproval = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, actionId: `${presentation.actionId}:changed` }),
    );
    expect(staleApproval.status).toBe(503);
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toEqual({
      agent_exists: true,
      auth_session_exists: true,
      deletion_case_exists: false,
      user_exists: true,
    });

    const response = yield* Effect.promise(() => app.account.delete(presentation));
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ status: "deletion-pending" });
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toBeNull();
    expect(yield* Effect.promise(app.supermemory.ledger)).toEqual([
      {
        method: "DELETE",
        path: expect.stringMatching(/^\/v3\/container-tags\/u_[A-Za-z0-9_-]+$/u),
      },
    ]);
    expect(yield* Effect.promise(app.supermemory.containers)).toEqual([
      unrelatedProvider.containerTag,
    ]);
    expect(yield* Effect.promise(() => directory.inspectAgent(identity.agentId))).toBeNull();
    expect(
      (yield* Effect.promise(() => directory.listAgents())).some(
        ({ name }) => name === identity.agentId,
      ),
    ).toBe(false);
    expect(yield* Effect.promise(() => env.FILES.head(targetR2Key))).toBeNull();
    expect(yield* Effect.promise(() => env.FILES.head(unrelatedR2Key))).not.toBeNull();

    const session = yield* Effect.promise(app.auth.session);
    expect(session.status).toBe(200);
    expect(yield* Effect.promise(() => session.json())).toBeNull();
    yield* Effect.promise(() => env.FILES.delete(unrelatedR2Key));
    return undefined;
  }),
);
