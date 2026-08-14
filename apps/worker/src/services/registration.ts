import { asc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import {
  database,
  type Database,
  DbTimestamp,
  dbUnavailable,
  dbWriteRejected,
  decodeOptionalRow,
  toD1Statement,
} from "../db";
import { agents, allowancePeriods, subscriptions, users } from "../db/schema";
import {
  AgentId,
  AllowancePeriodId,
  Plan,
  PlanPolicyVersion,
  RegistrationId,
  SubscriptionId,
  UserId,
} from "../domain";
import * as SecurityAudit from "./security-audit";

/** Result of atomically establishing the launch registration facts. */
export const RegistrationEstablished = Schema.Struct({
  agentId: AgentId,
  allowancePeriodId: AllowancePeriodId,
  plan: Plan,
  subscriptionId: SubscriptionId,
  userId: UserId,
});

/** Result of atomically establishing the launch registration facts. */
export type RegistrationEstablished = typeof RegistrationEstablished.Type;

/** Complete deterministic input for the atomic launch registration operation. */
export const RegisterInput = Schema.Struct({
  agentId: AgentId,
  allowancePeriodEndsAt: DbTimestamp,
  allowancePeriodId: AllowancePeriodId,
  allowancePeriodStartsAt: DbTimestamp,
  occurredAt: DbTimestamp,
  planPolicyVersion: PlanPolicyVersion,
  registrationId: RegistrationId,
  subscriptionId: SubscriptionId,
  userId: UserId,
});

/** Complete deterministic input for the atomic launch registration operation. */
export type RegisterInput = typeof RegisterInput.Type;

/** Expected failure when one Registration identity is reused for different facts. */
export class RegistrationConflict extends Schema.TaggedError<RegistrationConflict>()(
  "RegistrationConflict",
  {
    message: Schema.String,
    registrationId: RegistrationId,
  },
) {}

const StoredRegistration = Schema.Struct({
  agentId: AgentId,
  allowancePeriodEndsAt: DbTimestamp,
  allowancePeriodId: AllowancePeriodId,
  allowancePeriodStartsAt: DbTimestamp,
  occurredAt: DbTimestamp,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  registrationId: RegistrationId,
  subscriptionId: SubscriptionId,
  userId: UserId,
});

type StoredRegistration = typeof StoredRegistration.Type;

/** Atomically establish one User, Agent route, Free Plan, allowance, and audit fact. */
export const register = Effect.fn("Registration.register")(function* (input: RegisterInput) {
  const db = yield* database;
  const existing = yield* findRegistration(db, input.registrationId);
  if (existing !== undefined) {
    return yield* recoverExistingRegistration(input, existing);
  }

  const inserts = [
    db.insert(users).values({
      createdAt: input.occurredAt,
      registrationId: input.registrationId,
      userId: input.userId,
    }),
    db.insert(agents).values({
      agentId: input.agentId,
      createdAt: input.occurredAt,
      userId: input.userId,
    }),
    db.insert(subscriptions).values({
      createdAt: input.occurredAt,
      plan: "free",
      planPolicyVersion: input.planPolicyVersion,
      subscriptionId: input.subscriptionId,
      userId: input.userId,
    }),
    db.insert(allowancePeriods).values({
      allowancePeriodId: input.allowancePeriodId,
      endsAt: input.allowancePeriodEndsAt,
      plan: "free",
      planPolicyVersion: input.planPolicyVersion,
      startsAt: input.allowancePeriodStartsAt,
      userId: input.userId,
    }),
    SecurityAudit.registrationEstablished(db, input),
  ];

  return yield* db.$client.batch(inserts.map((query) => toD1Statement(db, query))).pipe(
    Effect.as(registrationEstablished(input)),
    Effect.catch((cause) => recoverConcurrentRegistration(db, input, cause)),
  );
});

const findRegistration = (db: Database, registrationId: RegistrationId) =>
  db
    .select({
      agentId: agents.agentId,
      allowancePeriodEndsAt: allowancePeriods.endsAt,
      allowancePeriodId: allowancePeriods.allowancePeriodId,
      allowancePeriodStartsAt: allowancePeriods.startsAt,
      occurredAt: users.createdAt,
      plan: subscriptions.plan,
      planPolicyVersion: subscriptions.planPolicyVersion,
      registrationId: users.registrationId,
      subscriptionId: subscriptions.subscriptionId,
      userId: users.userId,
    })
    .from(users)
    .innerJoin(agents, eq(agents.userId, users.userId))
    .innerJoin(subscriptions, eq(subscriptions.userId, users.userId))
    .innerJoin(allowancePeriods, eq(allowancePeriods.userId, users.userId))
    .where(eq(users.registrationId, registrationId))
    .orderBy(asc(allowancePeriods.startsAt))
    .limit(1)
    .pipe(
      Effect.mapError((cause) => dbUnavailable("establishRegistration", cause)),
      Effect.flatMap((rows) =>
        decodeOptionalRow(StoredRegistration, rows[0], "establishRegistration"),
      ),
    );

const recoverConcurrentRegistration = (db: Database, input: RegisterInput, cause: unknown) =>
  Effect.gen(function* () {
    const existing = yield* findRegistration(db, input.registrationId).pipe(
      Effect.mapError(() => dbUnavailable("establishRegistration", cause)),
    );
    if (existing === undefined) {
      return yield* dbWriteRejected("establishRegistration", input.registrationId, cause);
    }
    return yield* recoverExistingRegistration(input, existing);
  });

const recoverExistingRegistration = (input: RegisterInput, existing: StoredRegistration) =>
  matchesInput(existing, input)
    ? Effect.succeed(registrationEstablished(existing))
    : Effect.fail(
        new RegistrationConflict({
          message: "The Registration identity was already used for different facts",
          registrationId: input.registrationId,
        }),
      );

const matchesInput = (existing: StoredRegistration, input: RegisterInput) =>
  existing.agentId === input.agentId &&
  existing.allowancePeriodEndsAt === input.allowancePeriodEndsAt &&
  existing.allowancePeriodId === input.allowancePeriodId &&
  existing.allowancePeriodStartsAt === input.allowancePeriodStartsAt &&
  existing.occurredAt === input.occurredAt &&
  existing.plan === "free" &&
  existing.planPolicyVersion === input.planPolicyVersion &&
  existing.registrationId === input.registrationId &&
  existing.subscriptionId === input.subscriptionId &&
  existing.userId === input.userId;

const registrationEstablished = (
  input: RegisterInput | StoredRegistration,
): RegistrationEstablished => ({
  agentId: input.agentId,
  allowancePeriodId: input.allowancePeriodId,
  plan: "free",
  subscriptionId: input.subscriptionId,
  userId: input.userId,
});
