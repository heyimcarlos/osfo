/* oxlint-disable effecttsgo/strict-effect-provide -- The journey owns each PostgreSQL authority probe and its database scope. */
/* oxlint-disable effecttsgo/async-function -- Native Durable Object callbacks expose Promise boundaries for storage inspection. */
/* oxlint-disable effecttsgo/global-date-in-effect, vitest/no-standalone-expect -- This boundary fixture needs one fixed wire Date; assertions execute inside the Effect returned directly to it.effect. */
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { Effect, Result, Schema } from "effect";

import { OsfoAgent } from "../../src/agents/osfo/agent";
import { AccountDeletionAgent } from "../../src/composition/account-deletion-agent";
import { Db } from "../../src/db";
import { AgentId, UserId } from "../../src/domain";
import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
import { hourlyMaintenanceCron } from "../../src/scheduled-lifecycle";
import worker from "../../src/worker";
import { spawnApp } from "../support/spawn-app";

const AuthSessionResponse = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
});

const AccountDeletionActionUnavailable = Schema.TaggedStruct("AccountDeletionActionUnavailable", {
  message: Schema.String,
  requestState: Schema.Literal("notAccepted"),
});

const runScheduledMaintenance = (): Promise<void> => {
  const context = createExecutionContext();
  worker.scheduled(createScheduledController({ cron: hourlyMaintenanceCron }), env, context);
  return waitOnExecutionContext(context);
};

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
    yield* Effect.promise(() =>
      runInDurableObject(directory, async (owner) => {
        const agent = await owner.subAgent(OsfoAgent, identity.agentId);
        await agent.addMessages([
          {
            id: "account-erasure-message",
            role: "user",
            parts: [{ type: "text", text: "Account erasure sentinel" }],
          },
        ]);
      }),
    );
    // Inspect expected authority denials in the Effect channel: workerd logs rejected
    // native RPC calls as uncaught exceptions even when their callers catch them.
    const activeErasure = yield* Effect.scoped(
      AccountDeletionAgent.authorizeErasure(
        AgentId.make(identity.agentId),
        UserId.make(identity.userId),
      ).pipe(Effect.provide(Db.layer({ db: env.DB }))),
    ).pipe(Effect.result);
    expect(Result.isFailure(activeErasure)).toBe(true);
    expect(activeErasure).toMatchObject({
      failure: { _tag: "AccountDeletionUnavailable", operation: "eraseAgentStorage" },
    });
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
        expiresAt: new Date("2026-09-01T00:05:00.000Z"),
        operation: "account.delete",
        presentationVersion: "account-deletion-v1",
        replayToken: "a".repeat(43),
        title: "Delete Account",
      }),
    );
    expect(forgedWithoutPresentation.status).toBe(410);
    yield* Effect.promise(() => forgedWithoutPresentation.text());
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
    expect(invalidatedPresentation.status).toBe(410);
    yield* Effect.promise(() => invalidatedPresentation.text());
    const staleApproval = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, actionId: `${presentation.actionId}:changed` }),
    );
    expect(staleApproval.status).toBe(410);
    yield* Effect.promise(() => staleApproval.text());
    // The standard real-Wrangler envelope journey owns unsupported-version rejection.
    // Sending that malformed pre-route request through Miniflare prevents Workerd teardown.
    const guessedReplayBearer = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, replayToken: "z".repeat(43) }),
    );
    expect(guessedReplayBearer.status).toBe(410);
    yield* Effect.promise(() => guessedReplayBearer.text());
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
    const wrongOwnerErasure = yield* Effect.scoped(
      AccountDeletionAgent.authorizeErasure(
        AgentId.make(identity.agentId),
        UserId.make("unrelated-user-for-account-deletion"),
      ).pipe(Effect.provide(Db.layer({ db: env.DB }))),
    ).pipe(Effect.result);
    expect(Result.isFailure(wrongOwnerErasure)).toBe(true);
    expect(wrongOwnerErasure).toMatchObject({
      failure: { _tag: "AccountDeletionUnavailable", operation: "eraseAgentStorage" },
    });
    expect(yield* Effect.promise(() => directory.inspectAgent(identity.agentId))).not.toBeNull();
    app.auth.clearCookie();
    const fencedOrdinaryEndpoint = yield* Effect.promise(() => app.billing.checkout());
    expect(fencedOrdinaryEndpoint.response.status).toBe(401);
    yield* Effect.promise(() => fencedOrdinaryEndpoint.response.text());
    const mismatchedReplay = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, actionId: `${presentation.actionId}:changed` }),
    );
    expect(mismatchedReplay.status).toBe(401);
    yield* Effect.promise(() => mismatchedReplay.text());
    const mismatchedReplayBearer = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, replayToken: "z".repeat(43) }),
    );
    expect(mismatchedReplayBearer.status).toBe(401);
    yield* Effect.promise(() => mismatchedReplayBearer.text());
    const mismatchedReplayVersion = yield* Effect.promise(() =>
      app.account.delete({ ...presentation, presentationVersion: "account-deletion-v3" }),
    );
    expect(mismatchedReplayVersion.status).toBe(401);
    yield* Effect.promise(() => mismatchedReplayVersion.text());
    yield* Effect.promise(() =>
      app.database.expireAccountDeletionAction(identity.userId, presentation.actionId),
    );
    const lostResponseRetry = yield* Effect.promise(() => app.account.delete(presentation));
    expect(lostResponseRetry.status).toBe(200);
    expect(yield* Effect.promise(() => lostResponseRetry.json())).toEqual({
      status: "deletion-pending",
    });
    yield* Effect.promise(runScheduledMaintenance);
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
    yield* Effect.promise(() =>
      runInDurableObject(directory, async (owner) => {
        // Resolve the same native storage even when the directory registration is absent.
        const reopened = await owner.subAgent(OsfoAgent, identity.agentId);
        expect(await reopened.inspect()).toMatchObject({ _tag: "AgentStateNotFound" });
        expect(await reopened.getMessages()).toEqual([]);
      }),
    );
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

    yield* Effect.promise(runScheduledMaintenance);

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

it.effect("rejects an expired Action before fencing and accepts a fresh presentation", () =>
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
      Effect.promise(client.dispose),
    );
    const identity = yield* Effect.promise(() =>
      app.auth.mintVerifiedUser({ phoneNumber: "+15550001923" }),
    );
    const first = yield* Effect.promise(app.account.present);
    if (first.body === undefined) {
      return yield* Effect.die(new Error("Expiring deletion Action was not presented"));
    }
    const firstAction = first.body;

    yield* Effect.promise(() =>
      app.database.expireAccountDeletionAction(identity.userId, firstAction.actionId),
    );
    const rejected = yield* Effect.promise(() => app.account.delete(firstAction));

    expect(rejected.status).toBe(410);
    expect(
      yield* Schema.decodeUnknownEffect(AccountDeletionActionUnavailable)(
        yield* Effect.promise(() => rejected.json()),
      ),
    ).toEqual({
      _tag: "AccountDeletionActionUnavailable",
      message: "Request a fresh account deletion confirmation",
      requestState: "notAccepted",
    });
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toEqual({
      agent_exists: true,
      auth_session_exists: true,
      deletion_case_exists: false,
      user_exists: true,
    });

    const fresh = yield* Effect.promise(app.account.present);
    if (fresh.body === undefined) {
      return yield* Effect.die(new Error("Fresh deletion Action was not presented"));
    }
    const freshAction = fresh.body;
    expect(freshAction.actionId).not.toBe(firstAction.actionId);
    const accepted = yield* Effect.promise(() => app.account.delete(freshAction));
    expect(accepted.status).toBe(200);
    expect(yield* Effect.promise(() => accepted.json())).toEqual({ status: "deletion-pending" });
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toEqual({
      agent_exists: true,
      auth_session_exists: false,
      deletion_case_exists: true,
      user_exists: true,
    });
    yield* Effect.promise(runScheduledMaintenance);
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toBeNull();
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
    yield* Effect.promise(runScheduledMaintenance);
    expect(yield* Effect.promise(() => app.database.accountDeletion(identity.userId))).toBeNull();
    return undefined;
  }),
);
