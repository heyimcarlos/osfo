import { asc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import {
  AgentId,
  AllowancePeriodId,
  Plan,
  PlanPolicyVersion,
  SubscriptionId,
  UserId,
} from "../domain";
import {
  database,
  DbCommandId,
  DbTimestamp,
  dbCommandConflict,
  dbUnavailable,
  decodeRow,
  findCommand,
  fingerprintCommand,
  recoverConcurrentCommand,
  toD1Statement,
} from "../db";
import { agents, allowancePeriods, commands, subscriptions, users } from "../db/schema";
import * as AgentDirectory from "./agent-directory";
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
  commandId: DbCommandId,
  occurredAt: DbTimestamp,
  planPolicyVersion: PlanPolicyVersion,
  subscriptionId: SubscriptionId,
  userId: UserId,
});

/** Complete deterministic input for the atomic launch registration operation. */
export type RegisterInput = typeof RegisterInput.Type;

const SubscriptionSelection = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  plan: Plan,
  subscriptionId: SubscriptionId,
});

/** Atomically establish one User, Agent route, Free Plan, allowance, and audit fact. */
export const register = Effect.fn("Registration.register")(function* (input: RegisterInput) {
  const db = yield* database;
  const command = yield* fingerprintCommand("establishRegistration", input.commandId, [
    "establish_registration",
    input.agentId,
    input.allowancePeriodEndsAt,
    input.allowancePeriodId,
    input.allowancePeriodStartsAt,
    input.occurredAt,
    input.planPolicyVersion,
    input.subscriptionId,
    input.userId,
  ]);
  const existingCommand = yield* findCommand(db, input.commandId, "establishRegistration").pipe(
    Effect.mapError((cause) => dbUnavailable("establishRegistration", cause)),
  );
  if (existingCommand !== undefined) {
    if (existingCommand.requestDigest !== command.requestDigest) {
      return yield* dbCommandConflict(input.commandId);
    }
    return yield* readRegistration(input.userId);
  }

  const inserts = [
    db.insert(commands).values({
      commandId: input.commandId,
      completedAt: input.occurredAt,
      operation: "establish_registration",
      requestDigest: command.requestDigest,
    }),
    db.insert(users).values({ createdAt: input.occurredAt, userId: input.userId }),
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

  const concurrentResult = yield* db.$client
    .batch(inserts.map((query) => toD1Statement(db, query)))
    .pipe(
      Effect.as<RegistrationEstablished | undefined>(undefined),
      Effect.catch((cause) =>
        recoverConcurrentCommand(
          findCommand(db, input.commandId, "establishRegistration"),
          command,
          cause,
          "establishRegistration",
          readRegistration(input.userId),
        ),
      ),
    );
  return concurrentResult ?? registrationEstablished(input);
});

const readRegistration = (userId: UserId) =>
  Effect.all([AgentDirectory.resolveAgent(userId), readSubscription(userId)]).pipe(
    Effect.map(([route, subscription]) => ({ ...route, ...subscription })),
  );

const readSubscription = (userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* database;
    const rows = yield* db
      .select({
        allowancePeriodId: allowancePeriods.allowancePeriodId,
        plan: subscriptions.plan,
        subscriptionId: subscriptions.subscriptionId,
      })
      .from(subscriptions)
      .innerJoin(allowancePeriods, eq(allowancePeriods.userId, subscriptions.userId))
      .where(eq(subscriptions.userId, userId))
      .orderBy(asc(allowancePeriods.startsAt))
      .limit(1)
      .pipe(Effect.mapError((cause) => dbUnavailable("establishRegistration", cause)));
    const subscription = rows[0];
    if (subscription === undefined) {
      return yield* dbUnavailable(
        "establishRegistration",
        "No Subscription and allowance period exist for the User",
      );
    }
    return yield* decodeRow(SubscriptionSelection, subscription, "establishRegistration");
  });

const registrationEstablished = (input: RegisterInput): RegistrationEstablished => ({
  agentId: input.agentId,
  allowancePeriodId: input.allowancePeriodId,
  plan: "free",
  subscriptionId: input.subscriptionId,
  userId: input.userId,
});
