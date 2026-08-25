/* oxlint-disable effecttsgo/strict-effect-provide, vitest/no-standalone-expect -- The PostgreSQL contract test owns its concrete database Layer and assertions execute inside it.effect. */
/* oxlint-disable eslint/no-underscore-dangle -- Assertions inspect canonical tagged outcomes. */
import { env } from "cloudflare:workers";
import { agents } from "@osfo/db/schema/agents";
import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { expect, it } from "@effect/vitest";
import { BrowserCrypto } from "@effect/platform-browser";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";

import { Db } from "../../src/db";
import { PlanPolicyVersion, UserId } from "../../src/domain";
import { AuthSessionId } from "../../src/domain/auth-session";
import { AdminActorId, AdminReason } from "../../src/domain/account-administration";
import { DeletionCaseId } from "../../src/domain/deletion-case";
import { ActionId } from "../../src/domain/action-execution";
import { ApprovalPresentation } from "../../src/services/authorization";
import { AccountDeletion } from "../../src/services/account-deletion";
import { AccountAuthorities } from "../../src/composition/account-authorities";
import { AccountDeletionPostgres } from "../../src/integrations/postgres/account-deletion";
import { DeletionCasePostgres } from "../../src/integrations/postgres/deletion-case";
import { spawnApp } from "../support/spawn-app";

it.effect("retains a valid self-service fence and atomically removes the User graph", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // This adapter-level journey proves the PostgreSQL transaction and cascades that the
      // public DELETE response cannot expose independently.
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const userId = yield* registerUser(app);
      const database = yield* Db.database;
      const deletionCasesPersistence = yield* DeletionCasePostgres.make;
      const [authSession] = yield* Effect.promise(() =>
        database
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.userId, userId))
          .limit(1),
      );
      if (authSession === undefined) return yield* Effect.die(new Error("AuthSession missing"));
      const approval = {
        actionId: ActionId.make("account-delete-1"),
        presentation: ApprovalPresentation.make("Delete Account"),
      };
      const authority = {
        authSessionId: AuthSessionId.make(authSession.id),
        plan: "free" as const,
        planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
      };

      expect(
        yield* deletionCasesPersistence.requestSelf(
          userId,
          DeletionCaseId.make("stale-session-case"),
          approval,
          { ...authority, authSessionId: AuthSessionId.make("revoked-session") },
        ),
      ).toEqual({ _tag: "AuthorityChanged" });
      expect(
        yield* deletionCasesPersistence.requestSelf(
          userId,
          DeletionCaseId.make("stale-subscription-case"),
          approval,
          { ...authority, plan: "adventurer" },
        ),
      ).toEqual({ _tag: "AuthorityChanged" });
      yield* Effect.promise(() =>
        database.insert(userSuspensionEvents).values({
          action: "suspended",
          admin_actor_id: "admin-1",
          event_id: "suspension-before-case",
          occurred_at: suspendedBeforeCaseAt,
          reason: "Security hold",
          user_id: userId,
        }),
      );
      expect(
        yield* deletionCasesPersistence.requestSelf(
          userId,
          DeletionCaseId.make("suspended-user-case"),
          approval,
          authority,
        ),
      ).toEqual({ _tag: "AuthorityChanged" });
      expect(
        yield* Effect.promise(() =>
          database.select().from(sessions).where(eq(sessions.userId, userId)),
        ),
      ).toHaveLength(1);
      expect(
        yield* Effect.promise(() =>
          database.select().from(deletionCases).where(eq(deletionCases.user_id, userId)),
        ),
      ).toEqual([]);
      yield* Effect.promise(() =>
        database.insert(userSuspensionEvents).values({
          action: "restored",
          admin_actor_id: "admin-1",
          event_id: "restoration-before-case",
          occurred_at: restoredBeforeCaseAt,
          reason: "Security hold cleared",
          user_id: userId,
        }),
      );

      expect(
        yield* deletionCasesPersistence.requestSelf(
          userId,
          DeletionCaseId.make("self-delete-case-1"),
          approval,
          authority,
        ),
      ).toEqual({ _tag: "Created" });
      expect(
        yield* Effect.promise(() =>
          database.select().from(sessions).where(eq(sessions.userId, userId)),
        ),
      ).toEqual([]);

      const accountDeletion = AccountDeletionPostgres.make(database);
      const [candidate] = yield* accountDeletion.pending;
      if (candidate === undefined || candidate._tag !== "SelfService") {
        return yield* Effect.die(new Error("Self-service Deletion Case missing"));
      }
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)(candidate),
      ).toMatchObject({
        resourceOwnerUserId: userId,
        subscription: { plan: "free" },
        user: { _tag: "ActiveUser", userId },
      });
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)({
          ...candidate,
          approvalPresentation: ApprovalPresentation.make("Changed presentation"),
        }),
      ).toBeNull();
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)({
          ...candidate,
          deletionCaseId: DeletionCaseId.make("changed-case"),
        }),
      ).toBeNull();

      yield* Effect.promise(() =>
        database.insert(userSuspensionEvents).values({
          action: "suspended",
          admin_actor_id: "admin-1",
          event_id: "suspension-after-case-1",
          occurred_at: suspendedAfterCaseAt,
          reason: "Security hold",
          user_id: userId,
        }),
      );
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)(candidate),
      ).toMatchObject({ user: { _tag: "SuspendedUser", userId } });

      yield* Effect.promise(() =>
        database.delete(billingSubscriptions).where(eq(billingSubscriptions.user_id, userId)),
      );
      expect(yield* AccountDeletionPostgres.inspectAuthorization(database)(candidate)).toBeNull();

      yield* accountDeletion.removeUser(userId);

      const [remainingUsers, remainingAgents, remainingCases] = yield* Effect.promise(() =>
        Promise.all([
          database.select().from(users).where(eq(users.id, userId)),
          database.select().from(agents).where(eq(agents.user_id, userId)),
          database.select().from(deletionCases).where(eq(deletionCases.user_id, userId)),
        ]),
      );
      expect(remainingUsers).toEqual([]);
      expect(remainingAgents).toEqual([]);
      expect(remainingCases).toEqual([]);
      return undefined;
    }).pipe(Effect.provide(Db.layer({ db: env.DB }))),
  ),
);

it.effect("discovers and rechecks an administrator-started deletion after fencing sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const userId = yield* registerUser(app, "+15550002523");
      const database = yield* Db.database;
      const authorities = yield* AccountAuthorities.make;
      const requested = yield* authorities.deletionCases.request({
        adminActorId: AdminActorId.make("admin-1"),
        reason: AdminReason.make("Required administrative erasure"),
        userId,
      });
      expect(requested._tag).toBe("DeletionRequested");
      expect(
        yield* Effect.promise(() =>
          database.select().from(sessions).where(eq(sessions.userId, userId)),
        ),
      ).toEqual([]);

      const accountDeletion = AccountDeletionPostgres.make(database);
      const candidate = (yield* accountDeletion.pending).find((item) => item.userId === userId);
      if (candidate === undefined || candidate._tag !== "Administrative") {
        return yield* Effect.die(new Error("Administrative Deletion Case missing"));
      }
      expect(candidate).toMatchObject({
        adminActorId: "admin-1",
        reason: "Required administrative erasure",
        userId,
      });
      const firstTarget = {
        connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-1"),
        userId,
      };
      const secondTarget = {
        connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-2"),
        userId,
      };
      expect(
        yield* accountDeletion.stageIntegrationTargets(candidate, [
          firstTarget,
          firstTarget,
          secondTarget,
        ]),
      ).toEqual([firstTarget, secondTarget]);
      yield* accountDeletion.confirmIntegrationTarget(candidate, firstTarget);
      expect(yield* accountDeletion.stageIntegrationTargets(candidate, [])).toEqual([secondTarget]);
      expect(yield* accountDeletion.stageIntegrationTargets(candidate, [firstTarget])).toEqual([
        firstTarget,
        secondTarget,
      ]);
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)(candidate),
      ).toMatchObject({ resourceOwnerUserId: userId });
      yield* Effect.promise(() =>
        database.delete(billingSubscriptions).where(eq(billingSubscriptions.user_id, userId)),
      );
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)(candidate),
      ).toMatchObject({
        resourceOwnerUserId: userId,
        subscription: { plan: "free" },
      });
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)({
          ...candidate,
          reason: AdminReason.make("Changed reason"),
        }),
      ).toBeNull();
      yield* accountDeletion.removeUser(userId);
      return undefined;
    }).pipe(Effect.provide(Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer))),
  ),
);

const registerUser = (app: Awaited<ReturnType<typeof spawnApp>>, phoneNumber = "+15550002522") =>
  Effect.gen(function* () {
    yield* Effect.promise(() => app.auth.sendPhoneOtp(phoneNumber));
    yield* Effect.promise(() => app.auth.verifyPhoneOtp(phoneNumber, "424242"));
    const completed = yield* Effect.promise(() =>
      app.registration.complete({ helpAreas: [], locale: "en", preferredName: "Delete Me" }),
    );
    if (completed.body === undefined) {
      return yield* Effect.die(new Error("Registration did not return an identity"));
    }
    return UserId.make(completed.body.userId);
  });

const suspendedBeforeCaseAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-25T12:00:00.000Z"));
const restoredBeforeCaseAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-25T12:01:00.000Z"));
const suspendedAfterCaseAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-25T12:02:00.000Z"));
