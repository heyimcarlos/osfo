import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { and, eq, gt, lt } from "drizzle-orm";
import { Context, Crypto, DateTime, Effect, Layer, Schema } from "effect";

import {
  type Database,
  Db,
  DbTimestamp,
  type DbUnavailable,
  type DbWriteRejected,
  dbUnavailable,
  dbWriteRejected,
  decodeOptionalRow,
} from "../db";
import {
  AgentId,
  AllowancePeriodId,
  BillingSubscriptionId,
  Plan,
  PlanPolicyVersion,
  UserId,
} from "../domain";

/** Completed registration returned to an authenticated User. */
export const RegistrationCompleted = Schema.Struct({
  agentId: AgentId,
  completedAt: Schema.Date,
  userId: UserId,
});

/** Completed registration returned to an authenticated User. */
export type RegistrationCompleted = typeof RegistrationCompleted.Type;

/** Expected failure when Better Auth has not created the User. */
export class RegistrationUserNotFound extends Schema.TaggedError<RegistrationUserNotFound>()(
  "RegistrationUserNotFound",
  {
    message: Schema.String,
    userId: UserId,
  },
) {}

/** Expected failure when secure registration identities cannot be generated. */
export class RegistrationIdUnavailable extends Schema.TaggedError<RegistrationIdUnavailable>()(
  "RegistrationIdUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Expected failures from the Registration authority. */
export type RegistrationError =
  | DbUnavailable
  | DbWriteRejected
  | RegistrationIdUnavailable
  | RegistrationUserNotFound;

/** Registration authority operations. */
export interface Interface {
  readonly complete: (userId: UserId) => Effect.Effect<RegistrationCompleted, RegistrationError>;
}

/** Authority that provisions every resource required by a new User. */
export class Service extends Context.Service<Service, Interface>()("@osfo/Registration") {}

/** Construct Registration from request-scoped runtime capabilities. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const dbService = yield* Db;

  const complete = Effect.fn("Registration.complete")((userId: UserId) =>
    Effect.scoped(
      dbService.database.pipe(
        Effect.flatMap((db) =>
          completeRegistration(db, crypto, userId).pipe(
            Effect.andThen(readCompletedRegistration(db, userId)),
          ),
        ),
      ),
    ),
  );

  return Service.of({ complete });
});

/** Registration Layer that preserves its database and cryptography requirements. */
export const layerWithoutDependencies = Layer.effect(Service, make);

const StoredRegistration = Schema.Struct({
  agentCreatedAt: Schema.NullOr(DbTimestamp),
  agentId: Schema.NullOr(AgentId),
  allowanceEndsAt: Schema.NullOr(Schema.Date),
  allowancePeriodId: Schema.NullOr(AllowancePeriodId),
  allowancePlan: Schema.NullOr(Plan),
  allowancePlanPolicyVersion: Schema.NullOr(PlanPolicyVersion),
  allowanceStartsAt: Schema.NullOr(Schema.Date),
  billingCreatedAt: Schema.NullOr(Schema.Date),
  billingPlan: Schema.NullOr(Plan),
  billingPlanPolicyVersion: Schema.NullOr(PlanPolicyVersion),
  billingSubscriptionId: Schema.NullOr(BillingSubscriptionId),
  billingUpdatedAt: Schema.NullOr(Schema.Date),
  registrationCompletedAt: Schema.NullOr(Schema.Date),
  userId: UserId,
});

type StoredRegistration = typeof StoredRegistration.Type;
type RegistrationReader = Pick<Database, "select">;

const readCompletedRegistration = Effect.fn("Registration.readCompleted")(function* (
  db: RegistrationReader,
  userId: UserId,
) {
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          agentCreatedAt: agents.createdAt,
          agentId: agents.agentId,
          allowanceEndsAt: allowancePeriods.endsAt,
          allowancePeriodId: allowancePeriods.allowancePeriodId,
          allowancePlan: allowancePeriods.plan,
          allowancePlanPolicyVersion: allowancePeriods.planPolicyVersion,
          allowanceStartsAt: allowancePeriods.startsAt,
          billingCreatedAt: billingSubscriptions.createdAt,
          billingPlan: billingSubscriptions.plan,
          billingPlanPolicyVersion: billingSubscriptions.planPolicyVersion,
          billingSubscriptionId: billingSubscriptions.billingSubscriptionId,
          billingUpdatedAt: billingSubscriptions.updatedAt,
          registrationCompletedAt: users.registrationCompletedAt,
          userId: users.id,
        })
        .from(users)
        .leftJoin(agents, eq(agents.userId, users.id))
        .leftJoin(billingSubscriptions, eq(billingSubscriptions.userId, users.id))
        .leftJoin(
          allowancePeriods,
          and(
            eq(allowancePeriods.userId, users.id),
            eq(allowancePeriods.billingSubscriptionId, billingSubscriptions.billingSubscriptionId),
            eq(allowancePeriods.startsAt, billingSubscriptions.createdAt),
          ),
        )
        .where(eq(users.id, userId))
        .limit(1)
        .execute(),
    catch: (cause) => dbUnavailable("completeRegistration", cause),
  });
  const stored = yield* decodeOptionalRow(StoredRegistration, rows[0], "completeRegistration");
  if (stored === undefined) {
    return yield* new RegistrationUserNotFound({
      message: "Better Auth has not created the registration User",
      userId,
    });
  }
  if (
    stored.registrationCompletedAt === null ||
    stored.agentId === null ||
    stored.agentCreatedAt !== stored.registrationCompletedAt.toISOString() ||
    stored.billingSubscriptionId === null ||
    stored.billingCreatedAt === null ||
    stored.billingUpdatedAt === null ||
    stored.billingPlan !== "free" ||
    stored.billingPlanPolicyVersion !== "launch-v1" ||
    stored.allowancePeriodId === null ||
    stored.allowanceStartsAt === null ||
    stored.allowanceEndsAt === null ||
    stored.allowancePlan !== "free" ||
    stored.allowancePlanPolicyVersion !== "launch-v1" ||
    stored.billingCreatedAt.getTime() !== stored.registrationCompletedAt.getTime() ||
    stored.billingUpdatedAt.getTime() !== stored.registrationCompletedAt.getTime() ||
    stored.allowanceStartsAt.getTime() !== stored.registrationCompletedAt.getTime() ||
    stored.allowanceEndsAt.getTime() !==
      stored.registrationCompletedAt.getTime() + 30 * 24 * 60 * 60 * 1_000
  ) {
    return yield* dbUnavailable("completeRegistration", stored);
  }
  return {
    agentId: stored.agentId,
    completedAt: stored.registrationCompletedAt,
    userId: stored.userId,
  };
});

const completeRegistration = Effect.fn("Registration.completeRegistration")(function* (
  db: Database,
  crypto: Crypto.Crypto,
  userId: UserId,
) {
  const occurredAt = yield* DateTime.now;
  const generatedIds = yield* Effect.all({
    agent: crypto.randomUUIDv7,
    allowancePeriod: crypto.randomUUIDv7,
    billingSubscription: crypto.randomUUIDv7,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new RegistrationIdUnavailable({
          cause,
          message: "Secure registration identities could not be generated",
        }),
    ),
  );
  const occurredAtTimestamp = DbTimestamp.make(DateTime.formatIso(occurredAt));
  const allowancePeriodEndsAt = DateTime.toDateUtc(DateTime.add(occurredAt, { days: 30 }));
  const completedAt = DateTime.toDateUtc(occurredAt);

  const result = yield* Effect.tryPromise({
    try: () =>
      // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this Promise transaction boundary.
      db.transaction(async (transaction) => {
        const [user] = await transaction
          .select({ registrationCompletedAt: users.registrationCompletedAt })
          .from(users)
          .where(eq(users.id, userId))
          .for("update")
          .limit(1);
        if (user === undefined) return "user-not-found" as const;
        if (user.registrationCompletedAt !== null) return "ready" as const;

        await transaction.insert(agents).values({
          agentId: AgentId.make(`agent-${generatedIds.agent}`),
          createdAt: occurredAtTimestamp,
          userId,
        });
        const billingSubscriptionId = BillingSubscriptionId.make(
          `billing-subscription-${generatedIds.billingSubscription}`,
        );
        await transaction.insert(billingSubscriptions).values({
          billingSubscriptionId,
          createdAt: completedAt,
          plan: "free",
          planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
          updatedAt: completedAt,
          userId,
        });
        await transaction
          .select({ billingSubscriptionId: billingSubscriptions.billingSubscriptionId })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.billingSubscriptionId, billingSubscriptionId))
          .for("update")
          .limit(1);
        const overlap = await transaction
          .select({ allowancePeriodId: allowancePeriods.allowancePeriodId })
          .from(allowancePeriods)
          .where(
            and(
              eq(allowancePeriods.userId, userId),
              lt(allowancePeriods.startsAt, allowancePeriodEndsAt),
              gt(allowancePeriods.endsAt, completedAt),
            ),
          )
          .limit(1);
        if (overlap[0] !== undefined) return "period-overlap" as const;
        await transaction.insert(allowancePeriods).values({
          allowancePeriodId: AllowancePeriodId.make(
            `allowance-period-${generatedIds.allowancePeriod}`,
          ),
          billingSubscriptionId,
          createdAt: completedAt,
          endsAt: allowancePeriodEndsAt,
          plan: "free",
          planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
          startsAt: completedAt,
          userId,
        });
        await transaction
          .update(users)
          .set({ registrationCompletedAt: completedAt, updatedAt: completedAt })
          .where(eq(users.id, userId));

        return "ready" as const;
      }),
    catch: (cause) => dbWriteRejected("completeRegistration", userId, cause),
  });

  if (result === "user-not-found") {
    return yield* new RegistrationUserNotFound({
      message: "Better Auth has not created the registration User",
      userId,
    });
  }
  if (result === "period-overlap") {
    return yield* dbWriteRejected("completeRegistration", userId, result);
  }
  return yield* Effect.void;
});
