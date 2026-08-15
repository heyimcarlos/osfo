import { expect, layer } from "@effect/vitest";
import { applyMigrations, makeTestDatabase } from "@osfo/db/testing";
import { users } from "@osfo/db/schema/auth";
import { Effect, Layer } from "effect";

import { database, DbTimestamp, dbUnavailable, layerFromDatabase } from "../src/db";
import {
  AgentId,
  AllowancePeriodId,
  PlanPolicyVersion,
  RegistrationId,
  SubscriptionId,
  UserId,
} from "../src/domain";
import * as AgentDirectory from "../src/services/agent-directory";
import * as Registration from "../src/services/registration";

const fixture = Effect.runSync(makeTestDatabase);
await Effect.runPromise(applyMigrations(fixture.client));
const dbLayer = layerFromDatabase(fixture.database);
const serviceLayer = Layer.merge(
  Registration.layerWithoutDependencies,
  AgentDirectory.layerWithoutDependencies,
).pipe(Layer.provideMerge(dbLayer));

layer(serviceLayer)("Control-plane services", (it) => {
  it.effect("atomically establishes registration and stable Agent routing", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* AgentDirectory.Service;
      const registration = yield* Registration.Service;
      yield* seedUser(UserId.make("user-001"));
      const created = yield* registration.complete({
        agentId: AgentId.make("agent-001"),
        allowancePeriodId: AllowancePeriodId.make("allowance-period-001"),
        allowancePeriodStartsAt: DbTimestamp.make("2026-08-01T00:00:00.000Z"),
        allowancePeriodEndsAt: DbTimestamp.make("2026-09-01T00:00:00.000Z"),
        occurredAt: DbTimestamp.make("2026-08-12T15:00:00.000Z"),
        planPolicyVersion: PlanPolicyVersion.make("launch-2026-08-12"),
        registrationId: RegistrationId.make("registration-001"),
        subscriptionId: SubscriptionId.make("subscription-001"),
        userId: UserId.make("user-001"),
      });
      const route = yield* agentDirectory.resolve(UserId.make("user-001"));

      expect(created).toEqual({
        agentId: "agent-001",
        allowancePeriodId: "allowance-period-001",
        plan: "free",
        subscriptionId: "subscription-001",
        userId: "user-001",
      });
      expect(route).toEqual({ agentId: "agent-001", userId: "user-001" });
    }),
  );

  it.effect("returns one registration when the same Registration arrives concurrently", () =>
    Effect.gen(function* () {
      const registration = yield* Registration.Service;
      yield* seedUser(UserId.make("user-duplicate"));
      const input = {
        agentId: AgentId.make("agent-duplicate"),
        allowancePeriodId: AllowancePeriodId.make("allowance-period-duplicate"),
        allowancePeriodStartsAt: DbTimestamp.make("2026-08-01T00:00:00.000Z"),
        allowancePeriodEndsAt: DbTimestamp.make("2026-09-01T00:00:00.000Z"),
        occurredAt: DbTimestamp.make("2026-08-12T15:01:00.000Z"),
        planPolicyVersion: PlanPolicyVersion.make("launch-2026-08-12"),
        registrationId: RegistrationId.make("registration-duplicate"),
        subscriptionId: SubscriptionId.make("subscription-duplicate"),
        userId: UserId.make("user-duplicate"),
      };

      const [first, duplicate] = yield* Effect.all(
        [registration.complete(input), registration.complete(input)],
        { concurrency: "unbounded" },
      );
      const exactDuplicate = yield* registration.complete(input);
      const conflict = yield* Effect.flip(
        registration.complete({
          ...input,
          planPolicyVersion: PlanPolicyVersion.make("conflicting-policy-version"),
        }),
      );

      expect(duplicate).toEqual(first);
      expect(exactDuplicate).toEqual(first);
      expect(conflict).toMatchObject({
        _tag: "RegistrationConflict",
        registrationId: "registration-duplicate",
      });
    }),
  );

  it.effect("rolls back every registration fact when an Agent route conflicts", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* AgentDirectory.Service;
      const registration = yield* Registration.Service;
      yield* seedUser(UserId.make("user-route-owner"));
      yield* seedUser(UserId.make("user-route-conflict"));
      const first = {
        agentId: AgentId.make("agent-route-conflict"),
        allowancePeriodId: AllowancePeriodId.make("allowance-period-route-owner"),
        allowancePeriodStartsAt: DbTimestamp.make("2026-08-01T00:00:00.000Z"),
        allowancePeriodEndsAt: DbTimestamp.make("2026-09-01T00:00:00.000Z"),
        occurredAt: DbTimestamp.make("2026-08-12T15:01:30.000Z"),
        planPolicyVersion: PlanPolicyVersion.make("launch-2026-08-12"),
        registrationId: RegistrationId.make("registration-route-owner"),
        subscriptionId: SubscriptionId.make("subscription-route-owner"),
        userId: UserId.make("user-route-owner"),
      };
      const second = {
        ...first,
        allowancePeriodId: AllowancePeriodId.make("allowance-period-route-conflict"),
        registrationId: RegistrationId.make("registration-route-conflict"),
        subscriptionId: SubscriptionId.make("subscription-route-conflict"),
        userId: UserId.make("user-route-conflict"),
      };

      yield* registration.complete(first);
      const failedCreate = yield* Effect.flip(registration.complete(second));
      const missingRoute = yield* Effect.flip(agentDirectory.resolve(second.userId));
      const retried = yield* registration.complete({
        ...second,
        agentId: AgentId.make("agent-route-retry"),
      });

      expect(failedCreate).toMatchObject({
        _tag: "DbWriteRejected",
        operationId: "registration-route-conflict",
      });
      expect(missingRoute).toMatchObject({
        _tag: "AgentRouteNotFound",
        userId: "user-route-conflict",
      });
      expect(retried.userId).toBe("user-route-conflict");
    }),
  );
});

const seedUser = (userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* database;
    yield* Effect.tryPromise({
      try: () =>
        db.insert(users).values({
          email: `${userId}@invalid.example`,
          id: userId,
          name: "Test User",
        }),
      catch: (cause) => dbUnavailable("establishRegistration", cause),
    });
  });
