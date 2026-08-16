import { agents } from "@osfo/db/schema/agents";
import { users } from "@osfo/db/schema/auth";
import { allowancePeriods, subscriptions } from "@osfo/db/schema/billing";
import { eq } from "drizzle-orm";
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
import { AgentId, AllowancePeriodId, PlanPolicyVersion, SubscriptionId, UserId } from "../domain";

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
          registrationCompletedAt: users.registrationCompletedAt,
          userId: users.id,
        })
        .from(users)
        .leftJoin(agents, eq(agents.userId, users.id))
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
    stored.agentCreatedAt !== stored.registrationCompletedAt.toISOString()
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
    subscription: crypto.randomUUIDv7,
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
  const allowancePeriodEndsAt = DbTimestamp.make(
    DateTime.formatIso(DateTime.add(occurredAt, { days: 30 })),
  );
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
        await transaction.insert(subscriptions).values({
          createdAt: occurredAtTimestamp,
          plan: "free",
          planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
          subscriptionId: SubscriptionId.make(`subscription-${generatedIds.subscription}`),
          userId,
        });
        await transaction.insert(allowancePeriods).values({
          allowancePeriodId: AllowancePeriodId.make(
            `allowance-period-${generatedIds.allowancePeriod}`,
          ),
          endsAt: allowancePeriodEndsAt,
          plan: "free",
          planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
          startsAt: occurredAtTimestamp,
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
  return yield* Effect.void;
});
