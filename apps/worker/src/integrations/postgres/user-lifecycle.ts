import { sessions, users } from "@osfo/db/schema/auth";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { and, desc, eq, ne } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

import * as Db from "../../db";
import type { Database } from "../../db";
import {
  AdminActorId,
  AuthSessionAuthorityFact,
  DeletionCaseId,
  LifecycleReason,
  UserLifecycleFacts,
  UserSuspensionEventId,
} from "../../domain/user-lifecycle";
import * as UserLifecycle from "../../services/user-lifecycle";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Drizzle transaction boundaries and domain tags require these forms. */

const SuspensionHistory = Schema.Array(
  Schema.Struct({
    action: Schema.Literals(["restored", "suspended"]),
    adminActorId: AdminActorId,
    eventId: UserSuspensionEventId,
    occurredAt: Schema.Date,
    reason: LifecycleReason,
  }),
);

/** Postgres implementation of the User lifecycle persistence port. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;

  return UserLifecycle.Persistence.of({
    inspectAuthSession: (userId, authSessionId) =>
      Db.execute("inspectUserLifecycle", () =>
        database
          .select({ expiresAt: sessions.expiresAt })
          .from(sessions)
          .where(and(eq(sessions.id, authSessionId), eq(sessions.userId, userId)))
          .limit(1),
      ).pipe(
        Effect.flatMap(([stored]) =>
          Schema.decodeUnknownEffect(AuthSessionAuthorityFact)(
            stored === undefined
              ? { _tag: "RevokedAuthSession", authSessionId, userId }
              : { _tag: "AuthSession", authSessionId, expiresAt: stored.expiresAt, userId },
          ).pipe(Effect.mapError((cause) => Db.dbUnavailable("inspectUserLifecycle", cause))),
        ),
      ),
    readPhoneReplacementFacts: (target) =>
      Db.execute("beginPhoneReplacement", () => phoneEligibility(database, target)).pipe(
        Effect.flatMap((facts) =>
          Schema.decodeEffect(UserLifecycle.PhoneReplacementFacts)(
            toPhoneReplacementFacts(facts),
          ).pipe(Effect.mapError((cause) => Db.dbUnavailable("beginPhoneReplacement", cause))),
        ),
      ),
    inspectUser: (userId) =>
      Db.execute("inspectUserLifecycle", () =>
        database.transaction(async (transaction) => {
          const [user, latestEvent, deletionCase] = await Promise.all([
            transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1),
            transaction
              .select({ action: userSuspensionEvents.action })
              .from(userSuspensionEvents)
              .where(eq(userSuspensionEvents.userId, userId))
              .orderBy(desc(userSuspensionEvents.occurredAt), desc(userSuspensionEvents.eventId))
              .limit(1),
            transaction
              .select({ id: deletionCases.deletionCaseId })
              .from(deletionCases)
              .where(eq(deletionCases.userId, userId))
              .limit(1),
          ]);
          return { deletionCase: deletionCase[0], latestEvent: latestEvent[0], user: user[0] };
        }),
      ).pipe(
        Effect.flatMap((stored) =>
          stored.user === undefined
            ? Effect.succeed(null)
            : Schema.decodeEffect(UserLifecycleFacts)({
                deletionAccess:
                  stored.deletionCase === undefined
                    ? { _tag: "DeletionAccessAvailable" }
                    : { _tag: "DeletionAccessRevoked" },
                user:
                  stored.latestEvent?.action === "suspended"
                    ? { _tag: "SuspendedUser", userId }
                    : { _tag: "ActiveUser", userId },
              }).pipe(Effect.mapError((cause) => Db.dbUnavailable("inspectUserLifecycle", cause))),
        ),
      ),
    replacePhoneAccount: (target) =>
      Db.execute("replacePhoneAccount", () =>
        database.transaction(async (transaction) => {
          const eligibility = await phoneEligibility(transaction, target, {
            userLock: "for-update",
          });
          if (eligibility.user === undefined) return "user-missing" as const;
          if (
            eligibility.user.phoneNumber === null ||
            eligibility.user.phoneNumberVerified !== true
          ) {
            return "phone-unverified" as const;
          }
          if (eligibility.deletionCase !== undefined) return "deletion-requested" as const;
          if (eligibility.collision !== undefined) return "phone-collision" as const;
          if (eligibility.user.phoneNumber === target.phoneNumber) return "unchanged" as const;
          await transaction
            .update(users)
            .set({ phoneNumber: target.phoneNumber, phoneNumberVerified: true })
            .where(eq(users.id, target.userId));
          await transaction.delete(sessions).where(eq(sessions.userId, target.userId));
          return "replaced" as const;
        }),
      ),
    requestDeletion: (command, deletionCaseId) =>
      Db.execute("requestDeletion", () =>
        database.transaction(async (transaction) => {
          const [user] = await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, command.userId))
            .for("update")
            .limit(1);
          if (user === undefined) return { _tag: "UserNotFound" } as const;
          const [existing] = await transaction
            .select({ deletionCaseId: deletionCases.deletionCaseId })
            .from(deletionCases)
            .where(eq(deletionCases.userId, command.userId))
            .limit(1);
          if (existing !== undefined) {
            return {
              _tag: "Existing",
              deletionCaseId: DeletionCaseId.make(existing.deletionCaseId),
            } as const;
          }
          await transaction.insert(deletionCases).values({
            deletionCaseId,
            reason: command.reason,
            requestedByAdminId: command.adminActorId,
            userId: command.userId,
          });
          await transaction.delete(sessions).where(eq(sessions.userId, command.userId));
          return { _tag: "Created" } as const;
        }),
      ),
    revokeAuthSession: (command) =>
      Db.execute("revokeAuthSession", () =>
        database.transaction(async (transaction) => {
          const [session] = await transaction
            .select({ userId: sessions.userId })
            .from(sessions)
            .where(eq(sessions.id, command.authSessionId))
            .for("update")
            .limit(1);
          if (session === undefined) return "absent" as const;
          if (session.userId !== command.userId) return "wrong-user" as const;
          await transaction.delete(sessions).where(eq(sessions.id, command.authSessionId));
          return "revoked" as const;
        }),
      ),
    suspensionHistory: (userId) =>
      Db.execute("inspectUserLifecycle", () =>
        database
          .select({
            action: userSuspensionEvents.action,
            adminActorId: userSuspensionEvents.adminActorId,
            eventId: userSuspensionEvents.eventId,
            occurredAt: userSuspensionEvents.occurredAt,
            reason: userSuspensionEvents.reason,
          })
          .from(userSuspensionEvents)
          .where(eq(userSuspensionEvents.userId, userId))
          .orderBy(userSuspensionEvents.occurredAt, userSuspensionEvents.eventId),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SuspensionHistory)),
        Effect.mapError((cause) =>
          cause._tag === "DbUnavailable" ? cause : Db.dbUnavailable("inspectUserLifecycle", cause),
        ),
      ),
    transitionSuspension: (command, eventId, action) =>
      Db.execute(action === "suspended" ? "suspendUser" : "restoreUser", () =>
        database.transaction(async (transaction) => {
          const [user] = await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, command.userId))
            .for("update")
            .limit(1);
          if (user === undefined) return "user-not-found" as const;
          const [latest] = await transaction
            .select({ action: userSuspensionEvents.action })
            .from(userSuspensionEvents)
            .where(eq(userSuspensionEvents.userId, command.userId))
            .orderBy(desc(userSuspensionEvents.occurredAt), desc(userSuspensionEvents.eventId))
            .limit(1);
          const suspended = latest?.action === "suspended";
          if ((action === "suspended" && suspended) || (action === "restored" && !suspended)) {
            return "unchanged" as const;
          }
          await transaction.insert(userSuspensionEvents).values({
            action,
            adminActorId: command.adminActorId,
            eventId,
            reason: command.reason,
            userId: command.userId,
          });
          return "changed" as const;
        }),
      ),
  });
});

/** User lifecycle Postgres Layer that preserves its request-scoped database dependency. */
export const layerWithoutDependencies = Layer.effect(UserLifecycle.Persistence, make);

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type PhoneDatabase = Database | Transaction;

const phoneEligibility = async (
  database: PhoneDatabase,
  target: UserLifecycle.PhoneReplacementTarget,
  options: { readonly userLock: "for-update" | "none" } = { userLock: "none" },
) => {
  const userQuery = database
    .select({ phoneNumber: users.phoneNumber, phoneNumberVerified: users.phoneNumberVerified })
    .from(users)
    .where(eq(users.id, target.userId));
  const [user] =
    options.userLock === "for-update"
      ? await userQuery.for("update").limit(1)
      : await userQuery.limit(1);
  const [[deletionCase], [collision]] = await Promise.all([
    database
      .select({ id: deletionCases.deletionCaseId })
      .from(deletionCases)
      .where(eq(deletionCases.userId, target.userId))
      .limit(1),
    database
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phoneNumber, target.phoneNumber), ne(users.id, target.userId)))
      .limit(1),
  ]);
  return { collision, deletionCase, user };
};

type PhoneEligibility = Awaited<ReturnType<typeof phoneEligibility>>;

const toPhoneReplacementFacts = (value: PhoneEligibility) => {
  if (value.user === undefined) return { _tag: "MissingUser" } as const;
  if (value.user.phoneNumber === null || value.user.phoneNumberVerified !== true) {
    return { _tag: "UnverifiedPhoneAccount" } as const;
  }
  return {
    _tag: "VerifiedPhoneAccount",
    currentPhoneNumber: value.user.phoneNumber,
    hasCollision: value.collision !== undefined,
    hasDeletionCase: value.deletionCase !== undefined,
  } as const;
};
