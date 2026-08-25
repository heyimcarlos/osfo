/* oxlint-disable effecttsgo/strict-effect-provide, vitest/no-standalone-expect -- The PostgreSQL contract test owns its concrete database Layer and assertions execute inside it.effect. */
import { env } from "cloudflare:workers";
import { agents } from "@osfo/db/schema/agents";
import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { DateTime, Effect } from "effect";

import { Db } from "../../src/db";
import { PlanPolicyVersion, UserId } from "../../src/domain";
import { AuthSessionId } from "../../src/domain/auth-session";
import { DeletionCaseId } from "../../src/domain/deletion-case";
import { ActionId } from "../../src/domain/action-execution";
import { ApprovalPresentation } from "../../src/services/authorization";
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
        presentation: ApprovalPresentation.make("Delete account"),
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
      if (candidate === undefined) return yield* Effect.die(new Error("Deletion Case missing"));
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

const registerUser = (app: Awaited<ReturnType<typeof spawnApp>>) =>
  Effect.gen(function* () {
    const phoneNumber = "+15550002522";
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
