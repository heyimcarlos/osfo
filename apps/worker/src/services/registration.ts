import { agents } from "@osfo/db/schema/agents";
import { users } from "@osfo/db/schema/auth";
import { allowancePeriods, subscriptions } from "@osfo/db/schema/billing";
import { asc, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";

import {
  database,
  type Database,
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
  Plan,
  PlanPolicyVersion,
  RegistrationId,
  SubscriptionId,
  UserId,
} from "../domain";

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

/** Expected failure when completed registration facts differ from the request. */
export class RegistrationConflict extends Schema.TaggedError<RegistrationConflict>()(
  "RegistrationConflict",
  {
    message: Schema.String,
    registrationId: RegistrationId,
  },
) {}

/** Expected failure when Better Auth has not created the registration User. */
export class RegistrationUserNotFound extends Schema.TaggedError<RegistrationUserNotFound>()(
  "RegistrationUserNotFound",
  {
    message: Schema.String,
    userId: UserId,
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
  subscriptionId: SubscriptionId,
  userId: UserId,
});

type StoredRegistration = typeof StoredRegistration.Type;
type StoredRegistrationEncoded = typeof StoredRegistration.Encoded;

type RegistrationReader = Pick<Database, "select">;

type RegistrationTransactionResult =
  | { readonly kind: "created" }
  | { readonly kind: "existing"; readonly row: StoredRegistrationEncoded }
  | { readonly kind: "inconsistent" }
  | { readonly kind: "recovered"; readonly value: RegistrationEstablished }
  | { readonly kind: "user-not-found" };

/** Expected failures from the registration authority. */
export type RegistrationError =
  | DbUnavailable
  | DbWriteRejected
  | RegistrationConflict
  | RegistrationUserNotFound;

/** Registration authority operations. */
export interface Interface {
  readonly complete: (
    input: RegisterInput,
  ) => Effect.Effect<RegistrationEstablished, RegistrationError>;
}

/** Authority that establishes every durable registration fact. */
export class Service extends Context.Service<Service, Interface>()("@osfo/Registration") {}

/** Construct registration from the current request-scoped database. */
export const make = Effect.gen(function* () {
  const db = yield* database;

  const complete = Effect.fn("Registration.complete")((input: RegisterInput) =>
    completeRegistration(db, input),
  );

  return Service.of({ complete });
});

/** Registration Layer that preserves its database requirement. */
export const layerWithoutDependencies = Layer.effect(Service, make);

const completeRegistration = Effect.fn("Registration.completeRegistration")(function* (
  db: Database,
  input: RegisterInput,
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this Promise transaction boundary.
      db.transaction(async (transaction): Promise<RegistrationTransactionResult> => {
        const [user] = await transaction
          .select({ registrationCompletedAt: users.registrationCompletedAt })
          .from(users)
          .where(eq(users.id, input.userId))
          .for("update")
          .limit(1);
        if (user === undefined) {
          return { kind: "user-not-found" };
        }
        if (user.registrationCompletedAt !== null) {
          const [existing] = await findRegistrationQuery(transaction, input.userId);
          return existing === undefined
            ? { kind: "inconsistent" }
            : { kind: "existing", row: existing };
        }

        await transaction.insert(agents).values({
          agentId: input.agentId,
          createdAt: input.occurredAt,
          userId: input.userId,
        });
        await transaction.insert(subscriptions).values({
          createdAt: input.occurredAt,
          plan: "free",
          planPolicyVersion: input.planPolicyVersion,
          subscriptionId: input.subscriptionId,
          userId: input.userId,
        });
        await transaction.insert(allowancePeriods).values({
          allowancePeriodId: input.allowancePeriodId,
          endsAt: input.allowancePeriodEndsAt,
          plan: "free",
          planPolicyVersion: input.planPolicyVersion,
          startsAt: input.allowancePeriodStartsAt,
          userId: input.userId,
        });
        const completedAt = DateTime.make(input.occurredAt);
        if (Option.isNone(completedAt)) {
          return { kind: "inconsistent" };
        }
        const completedAtDate = DateTime.toDateUtc(completedAt.value);
        await transaction
          .update(users)
          .set({ registrationCompletedAt: completedAtDate, updatedAt: completedAtDate })
          .where(eq(users.id, input.userId));

        return { kind: "created" };
      }),
    catch: (cause) => dbWriteRejected("establishRegistration", input.registrationId, cause),
  }).pipe(
    Effect.catchTag("DbWriteRejected", (error) =>
      recoverConcurrentRegistration(db, input, error.cause),
    ),
  );

  switch (result.kind) {
    case "created":
      return registrationEstablished(input);
    case "existing": {
      const existing = yield* decodeOptionalRow(
        StoredRegistration,
        result.row,
        "establishRegistration",
      );
      return existing === undefined
        ? yield* dbUnavailable("establishRegistration", result)
        : yield* recoverExistingRegistration(input, existing);
    }
    case "inconsistent":
      return yield* dbUnavailable("establishRegistration", result);
    case "recovered":
      return result.value;
    case "user-not-found":
      return yield* new RegistrationUserNotFound({
        message: "Better Auth has not created the registration User",
        userId: input.userId,
      });
  }

  return yield* dbUnavailable("establishRegistration", result);
});

const findRegistration = (db: RegistrationReader, userId: UserId) =>
  Effect.tryPromise({
    try: () => findRegistrationQuery(db, userId),
    catch: (cause) => dbUnavailable("establishRegistration", cause),
  }).pipe(
    Effect.flatMap((rows) =>
      decodeOptionalRow(StoredRegistration, rows[0], "establishRegistration"),
    ),
  );

const findRegistrationQuery = (db: RegistrationReader, userId: UserId) =>
  db
    .select({
      agentId: agents.agentId,
      allowancePeriodEndsAt: allowancePeriods.endsAt,
      allowancePeriodId: allowancePeriods.allowancePeriodId,
      allowancePeriodStartsAt: allowancePeriods.startsAt,
      occurredAt: agents.createdAt,
      plan: subscriptions.plan,
      planPolicyVersion: subscriptions.planPolicyVersion,
      subscriptionId: subscriptions.subscriptionId,
      userId: agents.userId,
    })
    .from(users)
    .innerJoin(agents, eq(agents.userId, users.id))
    .innerJoin(subscriptions, eq(subscriptions.userId, users.id))
    .innerJoin(allowancePeriods, eq(allowancePeriods.userId, users.id))
    .where(eq(users.id, userId))
    .orderBy(asc(allowancePeriods.startsAt))
    .limit(1)
    .execute();

const recoverConcurrentRegistration = (
  db: RegistrationReader,
  input: RegisterInput,
  cause: unknown,
) =>
  Effect.gen(function* () {
    const existing = yield* findRegistration(db, input.userId).pipe(
      Effect.mapError(() => dbUnavailable("establishRegistration", cause)),
    );
    if (existing === undefined) {
      return yield* dbWriteRejected("establishRegistration", input.registrationId, cause);
    }
    return yield* recoverExistingRegistration(input, existing);
  }).pipe(Effect.map((value) => ({ kind: "recovered", value }) as const));

const recoverExistingRegistration = (input: RegisterInput, existing: StoredRegistration) =>
  matchesInput(existing, input)
    ? Effect.succeed(registrationEstablished(existing))
    : Effect.fail(
        new RegistrationConflict({
          message: "Registration already completed with different facts",
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
