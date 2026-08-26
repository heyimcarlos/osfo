/* oxlint-disable effecttsgo/strict-effect-provide, vitest/no-standalone-expect -- The PostgreSQL contract test owns its concrete database Layer and assertions execute inside it.effect. */
/* oxlint-disable eslint/no-underscore-dangle -- Assertions inspect canonical tagged outcomes. */
import { env } from "cloudflare:workers";
import { agents } from "@osfo/db/schema/agents";
import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import {
  accountDeletionActions,
  administrativeAuthorities,
  deletionCases,
  userSuspensionEvents,
} from "@osfo/db/schema/user-lifecycle";
import { expect, it } from "@effect/vitest";
import { BrowserCrypto } from "@effect/platform-browser";
import { eq, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Result } from "effect";

import { Db } from "../../src/db";
import { PlanPolicyVersion, UserId } from "../../src/domain";
import { AuthSessionId } from "../../src/domain/auth-session";
import { AdminActorId, AdminReason } from "../../src/domain/account-administration";
import { DeletionCaseId } from "../../src/domain/deletion-case";
import { ActionId } from "../../src/domain/action-execution";
import { ApprovalPresentation } from "../../src/services/authorization";
import { DeletionCase } from "../../src/services/deletion-case";
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
        presentationVersion: "account-deletion-v1",
        replayTokenHash,
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
          database
            .select({ accessFencedAt: deletionCases.access_fenced_at })
            .from(deletionCases)
            .where(eq(deletionCases.user_id, userId)),
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
        yield* deletionCasesPersistence.presentSelf(userId, {
          ...approval,
          authSessionId: authority.authSessionId,
          expiresAt: retrySessionExpiresAt,
        }),
      ).toEqual({ _tag: "Presented" });

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
      expect(
        yield* Effect.promise(() =>
          database
            .select({ accessFencedAt: deletionCases.access_fenced_at })
            .from(deletionCases)
            .where(eq(deletionCases.user_id, userId)),
        ),
      ).toEqual([{ accessFencedAt: expect.any(Date) }]);

      yield* Effect.promise(() =>
        database.insert(sessions).values({
          expiresAt: retrySessionExpiresAt,
          id: authSession.id,
          token: "exact-retry-token",
          updatedAt: retrySessionUpdatedAt,
          userId,
        }),
      );
      expect(
        yield* deletionCasesPersistence.requestSelf(
          userId,
          DeletionCaseId.make("unused-retry-case"),
          approval,
          authority,
        ),
      ).toEqual({
        _tag: "Existing",
        deletionCaseId: DeletionCaseId.make("self-delete-case-1"),
      });
      expect(
        yield* Effect.promise(() =>
          database.select().from(sessions).where(eq(sessions.userId, userId)),
        ),
      ).toEqual([expect.objectContaining({ id: authSession.id })]);
      yield* Effect.promise(() => database.delete(sessions).where(eq(sessions.id, authSession.id)));

      yield* Effect.promise(() =>
        Promise.all([
          database.insert(sessions).values({
            expiresAt: retrySessionExpiresAt,
            id: "stale-approval-session",
            token: "stale-approval-token",
            updatedAt: retrySessionUpdatedAt,
            userId,
          }),
          database
            .update(deletionCases)
            .set({ access_fenced_at: null })
            .where(eq(deletionCases.user_id, userId)),
        ]),
      );
      expect(
        yield* deletionCasesPersistence.requestSelf(
          userId,
          DeletionCaseId.make("stale-approval-case"),
          { ...approval, actionId: ActionId.make("changed-action") },
          { ...authority, authSessionId: AuthSessionId.make("stale-approval-session") },
        ),
      ).toEqual({ _tag: "AuthorityChanged" });
      expect(
        yield* Effect.promise(() =>
          Promise.all([
            database.select().from(sessions).where(eq(sessions.userId, userId)),
            database
              .select({ accessFencedAt: deletionCases.access_fenced_at })
              .from(deletionCases)
              .where(eq(deletionCases.user_id, userId)),
          ]),
        ),
      ).toEqual([
        [expect.objectContaining({ id: "stale-approval-session" })],
        [{ accessFencedAt: null }],
      ]);

      const accountDeletion = AccountDeletionPostgres.make(database);
      const [candidate] = yield* accountDeletion.pending;
      if (candidate === undefined || candidate._tag !== "SelfService") {
        return yield* Effect.die(new Error("Self-service Deletion Case missing"));
      }
      yield* accountDeletion.ensureAccessFence(candidate);
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
      expect(
        Result.isFailure(yield* accountDeletion.removeUser(candidate).pipe(Effect.result)),
      ).toBe(true);
      expect(
        yield* Effect.promise(() => database.select().from(users).where(eq(users.id, userId))),
      ).toHaveLength(1);
      yield* Effect.promise(() =>
        database.insert(userSuspensionEvents).values({
          action: "restored",
          admin_actor_id: "admin-1",
          event_id: "restoration-after-case-1",
          occurred_at: restoredAfterCaseAt,
          reason: "Security hold cleared",
          user_id: userId,
        }),
      );
      yield* Effect.promise(() =>
        database
          .update(billingSubscriptions)
          .set({ plan_policy_version: "unretained-policy" })
          .where(eq(billingSubscriptions.user_id, userId)),
      );
      expect(
        Result.isFailure(yield* accountDeletion.removeUser(candidate).pipe(Effect.result)),
      ).toBe(true);
      expect(
        yield* Effect.promise(() => database.select().from(users).where(eq(users.id, userId))),
      ).toHaveLength(1);
      yield* Effect.promise(() =>
        database
          .update(billingSubscriptions)
          .set({ plan_policy_version: "launch-v1" })
          .where(eq(billingSubscriptions.user_id, userId)),
      );

      const [removedSubscription] = yield* Effect.promise(() =>
        database
          .delete(billingSubscriptions)
          .where(eq(billingSubscriptions.user_id, userId))
          .returning(),
      );
      if (removedSubscription === undefined) {
        return yield* Effect.die(new Error("Billing Subscription missing"));
      }
      expect(yield* AccountDeletionPostgres.inspectAuthorization(database)(candidate)).toBeNull();
      expect(
        Result.isFailure(yield* accountDeletion.removeUser(candidate).pipe(Effect.result)),
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          Promise.all([
            database.select().from(users).where(eq(users.id, userId)),
            database.select().from(deletionCases).where(eq(deletionCases.user_id, userId)),
          ]),
        ),
      ).toEqual([
        [expect.objectContaining({ id: userId })],
        [expect.objectContaining({ deletion_case_id: candidate.deletionCaseId })],
      ]);
      yield* Effect.promise(() =>
        database.insert(billingSubscriptions).values(removedSubscription),
      );

      yield* accountDeletion.removeUser(candidate);

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

it.effect("consumes only one exact current server-owned self-service deletion Action", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const userId = yield* registerUser(app, "+15550002531");
      const database = yield* Db.database;
      const persistence = yield* DeletionCasePostgres.make;
      const [registeredSession] = yield* Effect.promise(() =>
        database
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.userId, userId))
          .limit(1),
      );
      if (registeredSession === undefined) {
        return yield* Effect.die(new Error("Registered AuthSession missing"));
      }
      const initialAuthority = {
        authSessionId: AuthSessionId.make(registeredSession.id),
        plan: "free" as const,
        planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
      };
      const forgedApproval = selfDeletionApproval("forged");

      expect(
        yield* persistence.requestSelf(
          userId,
          DeletionCaseId.make("forged-case"),
          forgedApproval,
          initialAuthority,
        ),
      ).toEqual({ _tag: "AuthorityChanged" });

      const expiredApproval = selfDeletionApproval("expired");
      expect(
        yield* persistence.presentSelf(userId, {
          ...expiredApproval,
          authSessionId: initialAuthority.authSessionId,
          expiresAt: retrySessionExpiresAt,
        }),
      ).toEqual({ _tag: "Presented" });
      yield* Effect.promise(() =>
        database
          .update(accountDeletionActions)
          .set({
            created_at: expiredActionCreatedAt,
            expires_at: expiredActionExpiresAt,
          })
          .where(eq(accountDeletionActions.action_id, expiredApproval.actionId)),
      );
      expect(
        yield* persistence.requestSelf(
          userId,
          DeletionCaseId.make("expired-case"),
          expiredApproval,
          initialAuthority,
        ),
      ).toEqual({ _tag: "AuthorityChanged" });

      const versionApproval = selfDeletionApproval("version");
      yield* persistence.presentSelf(userId, {
        ...versionApproval,
        authSessionId: initialAuthority.authSessionId,
        expiresAt: retrySessionExpiresAt,
      });
      expect(
        yield* persistence.requestSelf(
          userId,
          DeletionCaseId.make("changed-version-case"),
          { ...versionApproval, presentationVersion: "account-deletion-v2" },
          initialAuthority,
        ),
      ).toEqual({ _tag: "AuthorityChanged" });

      const presentationApproval = selfDeletionApproval("presentation");
      yield* persistence.presentSelf(userId, {
        ...presentationApproval,
        authSessionId: initialAuthority.authSessionId,
        expiresAt: retrySessionExpiresAt,
      });
      expect(
        yield* persistence.requestSelf(
          userId,
          DeletionCaseId.make("changed-presentation-case"),
          {
            ...presentationApproval,
            presentation: ApprovalPresentation.make("changed-presentation"),
          },
          initialAuthority,
        ),
      ).toEqual({ _tag: "AuthorityChanged" });

      const revokedApproval = selfDeletionApproval("revoked-session");
      yield* persistence.presentSelf(userId, {
        ...revokedApproval,
        authSessionId: initialAuthority.authSessionId,
        expiresAt: retrySessionExpiresAt,
      });
      yield* Effect.promise(() =>
        database.delete(sessions).where(eq(sessions.id, initialAuthority.authSessionId)),
      );
      expect(
        yield* persistence.requestSelf(
          userId,
          DeletionCaseId.make("revoked-session-case"),
          revokedApproval,
          initialAuthority,
        ),
      ).toEqual({ _tag: "AuthorityChanged" });

      const replacementSessionId = AuthSessionId.make("retained-action-replacement-session");
      yield* Effect.promise(() =>
        database.insert(sessions).values({
          expiresAt: retrySessionExpiresAt,
          id: replacementSessionId,
          token: "retained-action-replacement-token",
          updatedAt: retrySessionUpdatedAt,
          userId,
        }),
      );
      const currentAuthority = { ...initialAuthority, authSessionId: replacementSessionId };
      const invalidatedApproval = selfDeletionApproval("invalidated");
      yield* persistence.presentSelf(userId, {
        ...invalidatedApproval,
        authSessionId: currentAuthority.authSessionId,
        expiresAt: retrySessionExpiresAt,
      });
      const exactApproval = selfDeletionApproval("exact");
      yield* persistence.presentSelf(userId, {
        ...exactApproval,
        authSessionId: currentAuthority.authSessionId,
        expiresAt: retrySessionExpiresAt,
      });
      expect(yield* persistence.authenticateSelfReplay(exactApproval)).toEqual({
        _tag: "Denied",
      });
      expect(
        yield* persistence.requestSelf(
          userId,
          DeletionCaseId.make("invalidated-case"),
          invalidatedApproval,
          currentAuthority,
        ),
      ).toEqual({ _tag: "AuthorityChanged" });

      const concurrent = yield* Effect.all(
        [
          persistence.requestSelf(
            userId,
            DeletionCaseId.make("exact-case"),
            exactApproval,
            currentAuthority,
          ),
          persistence.requestSelf(
            userId,
            DeletionCaseId.make("exact-case"),
            exactApproval,
            currentAuthority,
          ),
        ],
        { concurrency: "unbounded" },
      );
      expect(concurrent.filter(({ _tag }) => _tag === "Created")).toHaveLength(1);
      expect(concurrent).toContainEqual({
        _tag: "Existing",
        deletionCaseId: DeletionCaseId.make("exact-case"),
      });
      expect(
        yield* Effect.promise(() =>
          database.select().from(sessions).where(eq(sessions.userId, userId)),
        ),
      ).toEqual([]);
      const [retainedCase] = yield* Effect.promise(() =>
        database.select().from(deletionCases).where(eq(deletionCases.user_id, userId)),
      );
      const [consumedAction] = yield* Effect.promise(() =>
        database
          .select({
            consumedAt: accountDeletionActions.consumed_at,
            deletionCaseId: accountDeletionActions.deletion_case_id,
          })
          .from(accountDeletionActions)
          .where(eq(accountDeletionActions.action_id, exactApproval.actionId)),
      );
      expect(retainedCase).toEqual(expect.objectContaining({ access_fenced_at: expect.any(Date) }));
      expect(consumedAction).toEqual({
        consumedAt: expect.any(Date),
        deletionCaseId: retainedCase?.deletion_case_id,
      });
      expect(yield* persistence.authenticateSelfReplay(exactApproval)).toEqual({
        _tag: "Authenticated",
        deletionCaseId: DeletionCaseId.make("exact-case"),
        userId,
      });
      expect(
        yield* persistence.authenticateSelfReplay({
          ...exactApproval,
          replayTokenHash: DeletionCase.SelfDeletionReplayTokenHash.make("b".repeat(64)),
        }),
      ).toEqual({ _tag: "Denied" });
      expect(
        yield* persistence.authenticateSelfReplay({
          ...exactApproval,
          presentation: ApprovalPresentation.make("foreign presentation"),
        }),
      ).toEqual({ _tag: "Denied" });
      yield* Effect.promise(() =>
        database
          .update(accountDeletionActions)
          .set({
            created_at: expiredActionCreatedAt,
            expires_at: expiredActionExpiresAt,
          })
          .where(eq(accountDeletionActions.action_id, exactApproval.actionId)),
      );
      expect(yield* persistence.authenticateSelfReplay(exactApproval)).toEqual({
        _tag: "Authenticated",
        deletionCaseId: DeletionCaseId.make("exact-case"),
        userId,
      });

      yield* Effect.promise(() =>
        database.insert(sessions).values({
          expiresAt: retrySessionExpiresAt,
          id: "lost-response-retry-session",
          token: "lost-response-retry-token",
          updatedAt: retrySessionUpdatedAt,
          userId,
        }),
      );
      expect(
        yield* persistence.requestSelf(
          userId,
          DeletionCaseId.make("exact-case"),
          exactApproval,
          currentAuthority,
        ),
      ).toEqual({
        _tag: "Existing",
        deletionCaseId: DeletionCaseId.make("exact-case"),
      });
      expect(
        yield* Effect.promise(() =>
          database.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId)),
        ),
      ).toEqual([{ id: "lost-response-retry-session" }]);
      yield* Effect.promise(() =>
        database.delete(sessions).where(eq(sessions.id, "lost-response-retry-session")),
      );

      const accountDeletion = AccountDeletionPostgres.make(database);
      const candidate = (yield* accountDeletion.pending).find((item) => item.userId === userId);
      if (candidate === undefined) {
        return yield* Effect.die(new Error("Durable self-service Deletion Case missing"));
      }
      yield* accountDeletion.ensureAccessFence(candidate);
      yield* Effect.promise(() =>
        database
          .update(deletionCases)
          .set({ approval_presentation: "changed-retained-presentation" })
          .where(eq(deletionCases.deletion_case_id, DeletionCaseId.make("exact-case"))),
      );
      expect(
        yield* persistence.requestSelf(
          userId,
          DeletionCaseId.make("replay-case"),
          exactApproval,
          currentAuthority,
        ),
      ).toEqual({ _tag: "AuthorityChanged" });
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
      const deletionCasesPersistence = yield* DeletionCasePostgres.make;
      const command = {
        adminActorId: AdminActorId.make("admin-1"),
        reason: AdminReason.make("Required administrative erasure"),
        userId,
      };
      expect(yield* authorities.deletionCases.request(command)).toEqual({
        _tag: "DeletionAuthorityChanged",
      });
      expect(
        yield* Effect.promise(() =>
          database.select().from(sessions).where(eq(sessions.userId, userId)),
        ),
      ).toHaveLength(1);
      yield* Effect.promise(() =>
        database.insert(administrativeAuthorities).values({ admin_actor_id: "admin-1" }),
      );
      const requested = yield* authorities.deletionCases.request(command);
      expect(requested._tag).toBe("DeletionRequested");
      expect(
        yield* Effect.promise(() =>
          database.select().from(sessions).where(eq(sessions.userId, userId)),
        ),
      ).toEqual([]);
      expect(
        yield* Effect.promise(() =>
          database
            .select({ accessFencedAt: deletionCases.access_fenced_at })
            .from(deletionCases)
            .where(eq(deletionCases.user_id, userId)),
        ),
      ).toEqual([{ accessFencedAt: expect.any(Date) }]);

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
      yield* Effect.promise(() =>
        Promise.all([
          database
            .update(deletionCases)
            .set({ access_fenced_at: null })
            .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId)),
          database.insert(sessions).values({
            expiresAt: retrySessionExpiresAt,
            id: "admin-case-self-session",
            token: "admin-case-self-token",
            updatedAt: retrySessionUpdatedAt,
            userId,
          }),
        ]),
      );
      expect(
        yield* deletionCasesPersistence.requestSelf(
          userId,
          DeletionCaseId.make("self-case-over-admin-case"),
          {
            actionId: ActionId.make("self-action-over-admin-case"),
            presentation: ApprovalPresentation.make("Delete Account"),
            presentationVersion: "account-deletion-v1",
            replayTokenHash,
          },
          {
            authSessionId: AuthSessionId.make("admin-case-self-session"),
            plan: "free",
            planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
          },
        ),
      ).toEqual({ _tag: "AuthorityChanged" });
      const wrongCaseFence = yield* accountDeletion
        .ensureAccessFence({ ...candidate, deletionCaseId: DeletionCaseId.make("wrong-case") })
        .pipe(Effect.result);
      expect(Result.isFailure(wrongCaseFence)).toBe(true);
      expect(
        yield* Effect.promise(() =>
          database.select().from(sessions).where(eq(sessions.userId, userId)),
        ),
      ).toEqual([expect.objectContaining({ id: "admin-case-self-session" })]);
      expect(
        yield* Effect.promise(() =>
          database
            .select({ accessFencedAt: deletionCases.access_fenced_at })
            .from(deletionCases)
            .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId)),
        ),
      ).toEqual([{ accessFencedAt: null }]);
      yield* accountDeletion.ensureAccessFence(candidate);
      expect(
        yield* Effect.promise(() =>
          database
            .select({ accessFencedAt: deletionCases.access_fenced_at })
            .from(deletionCases)
            .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId)),
        ),
      ).toEqual([{ accessFencedAt: expect.any(Date) }]);
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
      expect(
        yield* accountDeletion.stageIntegrationTargets(candidate, [firstTarget, secondTarget]),
      ).toEqual([secondTarget]);
      const retainedProgress = [
        { ...firstTarget, status: "confirmed" as const },
        { ...secondTarget, status: "pending" as const },
      ];
      expect(
        yield* Effect.promise(() =>
          database
            .select({ targets: deletionCases.integration_targets })
            .from(deletionCases)
            .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId))
            .limit(1),
        ),
      ).toEqual([{ targets: retainedProgress }]);
      const metadataDriftedStage = yield* accountDeletion
        .stageIntegrationTargets(candidate, [
          {
            connectionId: firstTarget.connectionId,
            userId: UserId.make("another-user"),
          },
        ])
        .pipe(Effect.result);
      expect(Result.isFailure(metadataDriftedStage)).toBe(true);
      expect(
        yield* Effect.promise(() =>
          database
            .select({ targets: deletionCases.integration_targets })
            .from(deletionCases)
            .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId))
            .limit(1),
        ),
      ).toEqual([{ targets: retainedProgress }]);
      yield* Effect.promise(() =>
        database
          .update(deletionCases)
          .set({ reason: "Changed retained authority" })
          .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId)),
      );
      const authorityDriftedStage = yield* accountDeletion
        .stageIntegrationTargets(candidate, [
          {
            connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-3"),
            userId,
          },
        ])
        .pipe(Effect.result);
      expect(Result.isFailure(authorityDriftedStage)).toBe(true);
      expect(
        yield* Effect.promise(() =>
          database
            .select({ targets: deletionCases.integration_targets })
            .from(deletionCases)
            .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId))
            .limit(1),
        ),
      ).toEqual([{ targets: retainedProgress }]);
      yield* Effect.promise(() =>
        database
          .update(deletionCases)
          .set({ reason: candidate.reason })
          .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId)),
      );
      const revokedAtBeforeConfirmation = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      yield* Effect.promise(() =>
        database
          .update(administrativeAuthorities)
          .set({ revoked_at: revokedAtBeforeConfirmation })
          .where(eq(administrativeAuthorities.admin_actor_id, candidate.adminActorId)),
      );
      const authorityDriftedConfirmation = yield* accountDeletion
        .confirmIntegrationTarget(candidate, firstTarget)
        .pipe(Effect.result);
      expect(Result.isFailure(authorityDriftedConfirmation)).toBe(true);
      expect(
        yield* Effect.promise(() =>
          database
            .select({ targets: deletionCases.integration_targets })
            .from(deletionCases)
            .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId))
            .limit(1),
        ),
      ).toEqual([{ targets: retainedProgress }]);
      yield* Effect.promise(() =>
        database
          .update(administrativeAuthorities)
          .set({ revoked_at: null })
          .where(eq(administrativeAuthorities.admin_actor_id, candidate.adminActorId)),
      );
      yield* Effect.promise(() =>
        database
          .update(deletionCases)
          .set({ integration_targets: sql`'{"unexpected":true}'::jsonb` })
          .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId)),
      );
      const malformedStage = yield* accountDeletion
        .stageIntegrationTargets(candidate, [firstTarget])
        .pipe(Effect.result);
      const malformedConfirmation = yield* accountDeletion
        .confirmIntegrationTarget(candidate, firstTarget)
        .pipe(Effect.result);
      expect(Result.isFailure(malformedStage)).toBe(true);
      expect(Result.isFailure(malformedConfirmation)).toBe(true);
      if (Result.isFailure(malformedStage) && Result.isFailure(malformedConfirmation)) {
        expect(malformedStage.failure).toMatchObject({
          _tag: "AccountDeletionUnavailable",
          operation: "stageIntegrationTargets",
        });
        expect(malformedConfirmation.failure).toMatchObject({
          _tag: "AccountDeletionUnavailable",
          operation: "confirmIntegrationTarget",
        });
      }
      expect(
        yield* Effect.promise(() =>
          database
            .select({ targets: deletionCases.integration_targets })
            .from(deletionCases)
            .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId))
            .limit(1),
        ),
      ).toEqual([{ targets: { unexpected: true } }]);
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)(candidate),
      ).toMatchObject({ resourceOwnerUserId: userId });
      yield* Effect.promise(() =>
        database.delete(billingSubscriptions).where(eq(billingSubscriptions.user_id, userId)),
      );
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)(candidate),
      ).toMatchObject({
        administrativeAuthority: { adminActorId: "admin-1" },
        resourceOwnerUserId: userId,
        subscription: { plan: "free" },
      });
      expect(
        yield* AccountDeletionPostgres.inspectAuthorization(database)({
          ...candidate,
          reason: AdminReason.make("Changed reason"),
        }),
      ).toBeNull();
      const revokedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      yield* Effect.promise(() =>
        Promise.all([
          database
            .update(administrativeAuthorities)
            .set({ revoked_at: revokedAt })
            .where(eq(administrativeAuthorities.admin_actor_id, "admin-1")),
          database.insert(sessions).values({
            expiresAt: retrySessionExpiresAt,
            id: "session-before-final-admin-delete",
            token: "token-before-final-admin-delete",
            updatedAt: retrySessionUpdatedAt,
            userId,
          }),
        ]),
      );
      expect(yield* AccountDeletionPostgres.inspectAuthorization(database)(candidate)).toBeNull();
      const revokedRemoval = yield* accountDeletion.removeUser(candidate).pipe(Effect.result);
      expect(Result.isFailure(revokedRemoval)).toBe(true);
      expect(
        yield* Effect.promise(() =>
          Promise.all([
            database.select().from(users).where(eq(users.id, userId)),
            database.select().from(sessions).where(eq(sessions.userId, userId)),
            database.select().from(deletionCases).where(eq(deletionCases.user_id, userId)),
          ]),
        ),
      ).toEqual([
        [expect.objectContaining({ id: userId })],
        [expect.objectContaining({ id: "session-before-final-admin-delete" })],
        [expect.objectContaining({ access_fenced_at: expect.any(Date) })],
      ]);
      yield* Effect.promise(() =>
        Promise.all([
          database
            .update(administrativeAuthorities)
            .set({ revoked_at: null })
            .where(eq(administrativeAuthorities.admin_actor_id, candidate.adminActorId)),
          database
            .update(deletionCases)
            .set({ reason: "Wrong final reason" })
            .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId)),
        ]),
      );
      expect(
        Result.isFailure(yield* accountDeletion.removeUser(candidate).pipe(Effect.result)),
      ).toBe(true);
      expect(
        yield* Effect.promise(() => database.select().from(users).where(eq(users.id, userId))),
      ).toHaveLength(1);
      yield* Effect.promise(() =>
        database
          .update(deletionCases)
          .set({ reason: candidate.reason })
          .where(eq(deletionCases.deletion_case_id, candidate.deletionCaseId)),
      );
      yield* accountDeletion.ensureAccessFence(candidate);
      yield* accountDeletion.removeUser(candidate);
      expect(
        yield* Effect.promise(() => database.select().from(users).where(eq(users.id, userId))),
      ).toEqual([]);
      return undefined;
    }).pipe(Effect.provide(Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer))),
  ),
);

it.effect(
  "keeps an administrative request unfenced when authority revokes after case creation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
          Effect.promise(client.dispose),
        );
        const userId = yield* registerUser(app, "+15550002524");
        const database = yield* Db.database;
        const persistence = yield* DeletionCasePostgres.make;
        const command = {
          adminActorId: AdminActorId.make("admin-fence-race"),
          reason: AdminReason.make("Required administrative erasure"),
          userId,
        };
        const deletionCaseId = DeletionCaseId.make("admin-fence-race-case");
        yield* Effect.promise(() =>
          database.insert(administrativeAuthorities).values({
            admin_actor_id: command.adminActorId,
          }),
        );
        expect(yield* persistence.request(command, deletionCaseId)).toEqual({ _tag: "Created" });
        yield* Effect.promise(() =>
          database
            .update(administrativeAuthorities)
            .set({ revoked_at: retrySessionUpdatedAt })
            .where(eq(administrativeAuthorities.admin_actor_id, command.adminActorId)),
        );

        expect(yield* persistence.markAccessFenced(command, deletionCaseId)).toEqual({
          _tag: "AuthorityChanged",
        });
        expect(
          yield* Effect.promise(() =>
            Promise.all([
              database.select().from(sessions).where(eq(sessions.userId, userId)),
              database
                .select({ accessFencedAt: deletionCases.access_fenced_at })
                .from(deletionCases)
                .where(eq(deletionCases.deletion_case_id, deletionCaseId)),
            ]),
          ),
        ).toEqual([[expect.any(Object)], [{ accessFencedAt: null }]]);
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

const selfDeletionApproval = (identity: string) => ({
  actionId: ActionId.make(`account-delete:${identity}`),
  presentation: ApprovalPresentation.make(
    JSON.stringify({
      actionId: `account-delete:${identity}`,
      confirmation: "delete-my-account",
      consequence: "Permanently delete this account and all of its data.",
      operation: "account.delete",
      title: "Delete Account",
    }),
  ),
  presentationVersion: "account-deletion-v1",
  replayTokenHash,
});

const replayTokenHash = DeletionCase.SelfDeletionReplayTokenHash.make("a".repeat(64));

const suspendedBeforeCaseAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-25T12:00:00.000Z"));
const restoredBeforeCaseAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-25T12:01:00.000Z"));
const suspendedAfterCaseAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-25T12:02:00.000Z"));
const restoredAfterCaseAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-25T12:03:00.000Z"));
const retrySessionExpiresAt = DateTime.toDateUtc(DateTime.makeUnsafe("2027-08-25T12:00:00.000Z"));
const retrySessionUpdatedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-25T12:04:00.000Z"));
const expiredActionCreatedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-08-25T12:00:00.000Z"));
const expiredActionExpiresAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-08-25T12:05:00.000Z"));
