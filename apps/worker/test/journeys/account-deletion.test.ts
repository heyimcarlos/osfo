/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { App } from "../../src/app";
import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
import { spawnApp } from "../support/spawn-app";

const AuthSessionResponse = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

    const liveSession = yield* Effect.promise(app.auth.session);
    const liveSessionJson = yield* Effect.promise(() => liveSession.json());
    const liveSessionBody = yield* Schema.decodeUnknownEffect(AuthSessionResponse)(liveSessionJson);
    const liveSessionId = liveSessionBody.session.id;
    const forgedWithoutPresentation = yield* Effect.promise(() =>
      app.account.delete({
        actionId: `account-delete:${liveSessionId}`,
        confirmation: "delete-my-account",
        consequence: "Permanently delete this account and all of its data.",
        operation: "account.delete",
        presentationVersion: "account-deletion-v1",
        replayToken: "a".repeat(43),
        title: "Delete Account",
      }),
    );
    expect(forgedWithoutPresentation.status).toBe(503);
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toEqual({
      agent_exists: true,
      auth_session_exists: true,
      deletion_case_exists: false,
      user_exists: true,
    });

    const firstPresented = yield* Effect.promise(app.account.present);
    expect(firstPresented.response.status).toBe(200);
    if (firstPresented.body === undefined) {
      return yield* Effect.die(new Error("First account deletion Action was not presented"));
    }
    const firstPresentation = firstPresented.body;
    const presented = yield* Effect.promise(app.account.present);
    expect(presented.response.status).toBe(200);
    if (presented.body === undefined) {
      return yield* Effect.die(new Error("Account deletion was not presented"));
    }
    const presentation = presented.body;
    expect(presentation.actionId).not.toBe(firstPresentation.actionId);
    const invalidatedPresentation = yield* Effect.promise(() =>
      app.account.delete(firstPresentation),
    );
    expect(invalidatedPresentation.status).toBe(503);
    const staleApproval = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, actionId: `${presentation.actionId}:changed` }),
    );
    expect(staleApproval.status).toBe(503);
    const wrongPresentationVersion = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, presentationVersion: "account-deletion-v3" }),
    );
    expect(wrongPresentationVersion.status).toBe(400);
    const guessedReplayBearer = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, replayToken: "z".repeat(43) }),
    );
    expect(guessedReplayBearer.status).toBe(503);
    const exactPayload = {
      approval: {
        decision: "approved",
        presentation: {
          actionId: presentation.actionId,
          confirmation: presentation.confirmation,
          consequence: presentation.consequence,
          operation: presentation.operation,
          title: presentation.title,
        },
      },
      confirmation: presentation.confirmation,
      presentationVersion: presentation.presentationVersion,
      replayToken: presentation.replayToken,
    } as const;
    const editedTitle = yield* Effect.promise(() =>
      app.fetch("/v1/account", {
        body: encodeJson({
          ...exactPayload,
          approval: {
            ...exactPayload.approval,
            presentation: { ...exactPayload.approval.presentation, title: "DELETE ACCOUNT" },
          },
        }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      }),
    );
    expect(editedTitle.status).toBe(400);
    const editedConsequence = yield* Effect.promise(() =>
      app.fetch("/v1/account", {
        body: encodeJson({
          ...exactPayload,
          approval: {
            ...exactPayload.approval,
            presentation: {
              ...exactPayload.approval.presentation,
              consequence: "Delete selected account data.",
            },
          },
        }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      }),
    );
    expect(editedConsequence.status).toBe(400);
    const editedConfirmation = yield* Effect.promise(() =>
      app.fetch("/v1/account", {
        body: encodeJson({ ...exactPayload, confirmation: "delete-account-now" }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      }),
    );
    expect(editedConfirmation.status).toBe(400);
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toEqual({
      agent_exists: true,
      auth_session_exists: true,
      deletion_case_exists: false,
      user_exists: true,
    });

    const response = yield* Effect.promise(() => app.account.delete(presentation));
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ status: "deletion-pending" });
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toEqual({
      agent_exists: true,
      auth_session_exists: false,
      deletion_case_exists: true,
      user_exists: true,
    });
    expect(yield* Effect.promise(app.supermemory.ledger)).toEqual([]);
    app.auth.clearCookie();
    const fencedOrdinaryEndpoint = yield* Effect.promise(() => app.billing.checkout());
    expect(fencedOrdinaryEndpoint.response.status).toBe(401);
    const mismatchedReplay = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, actionId: `${presentation.actionId}:changed` }),
    );
    expect(mismatchedReplay.status).toBe(401);
    const mismatchedReplayBearer = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, replayToken: "z".repeat(43) }),
    );
    expect(mismatchedReplayBearer.status).toBe(401);
    const mismatchedReplayVersion = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, presentationVersion: "account-deletion-v3" }),
    );
    expect(mismatchedReplayVersion.status).toBe(401);
    yield* Effect.promise(() =>
      app.database.expireAccountDeletionAction(identity.userId, presentation.actionId),
    );
    const lostResponseRetry = yield* Effect.promise(() => app.account.delete(presentation));
    expect(lostResponseRetry.status).toBe(200);
    expect(yield* Effect.promise(() => lostResponseRetry.json())).toEqual({
      status: "deletion-pending",
    });
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toBeNull();
    expect(yield* Effect.promise(app.supermemory.ledger)).toEqual([
      {
        method: "DELETE",
        path: `/v3/container-tags/${encodeURIComponent(seededProvider.containerTag)}`,
      },
      {
        method: "GET",
        path: `/v3/container-tags/${encodeURIComponent(seededProvider.containerTag)}`,
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

it.effect("completes a fenced deletion through the production scheduled entry point", () =>
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
      Effect.promise(client.dispose),
    );
    const identity = yield* Effect.promise(() =>
      app.auth.mintVerifiedUser({ phoneNumber: "+15550001921" }),
    );
    const seededProvider = yield* Effect.promise(() => app.supermemory.seedUser(identity.userId));
    const presented = yield* Effect.promise(app.account.present);
    if (presented.body === undefined) {
      return yield* Effect.die(new Error("Scheduled deletion Action was not presented"));
    }
    const presentation = presented.body;

    const accepted = yield* Effect.promise(() => app.account.delete(presentation));
    expect(accepted.status).toBe(200);
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toEqual({
      agent_exists: true,
      auth_session_exists: false,
      deletion_case_exists: true,
      user_exists: true,
    });
    expect(yield* Effect.promise(app.supermemory.ledger)).toEqual([]);

    yield* Effect.promise(() => App.reconcileAccountDeletions(env));

    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toBeNull();
    expect(yield* Effect.promise(app.supermemory.ledger)).toEqual([
      {
        method: "DELETE",
        path: `/v3/container-tags/${encodeURIComponent(seededProvider.containerTag)}`,
      },
      {
        method: "GET",
        path: `/v3/container-tags/${encodeURIComponent(seededProvider.containerTag)}`,
      },
    ]);
    return undefined;
  }),
);

it.effect("submits a retained v1 presentation after the Worker advances to v2", () =>
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
      Effect.promise(client.dispose),
    );
    const identity = yield* Effect.promise(() =>
      app.auth.mintVerifiedUser({ phoneNumber: "+15550001922" }),
    );
    const presented = yield* Effect.promise(app.account.present);
    if (presented.body === undefined) {
      return yield* Effect.die(new Error("Rollover deletion Action was not presented"));
    }
    const currentV2 = presented.body;
    expect(currentV2.presentationVersion).toBe("account-deletion-v2");
    yield* Effect.promise(() =>
      app.database.versionAccountDeletionAction(
        identity.userId,
        currentV2.actionId,
        "account-deletion-v1",
      ),
    );

    const retainedV1 = { ...currentV2, presentationVersion: "account-deletion-v1" };
    const accepted = yield* Effect.promise(() => app.account.delete(retainedV1));
    expect(accepted.status).toBe(200);
    expect(yield* Effect.promise(() => accepted.json())).toEqual({ status: "deletion-pending" });
    app.auth.clearCookie();
    yield* Effect.promise(() =>
      app.database.expireAccountDeletionAction(identity.userId, retainedV1.actionId),
    );
    const replayed = yield* Effect.promise(() => app.account.delete(retainedV1));
    expect(replayed.status).toBe(200);
    expect(yield* Effect.promise(() => replayed.json())).toEqual({ status: "deletion-pending" });
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toBeNull();
    return undefined;
  }),
);
