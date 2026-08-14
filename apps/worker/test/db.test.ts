import { expect, layer } from "@effect/vitest";
import { applyMigrations, makeTestDatabase } from "@osfo/db/testing";
import { securityAuditFacts } from "@osfo/db/schema/security-audit";
import { users } from "@osfo/db/schema/auth";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

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

layer(layerFromDatabase(fixture.database))("Db", (it) => {
  it.effect("atomically establishes registration and stable Agent routing", () =>
    Effect.gen(function* () {
      yield* seedUser(UserId.make("user-001"));
      const created = yield* Registration.register({
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
      const route = yield* AgentDirectory.resolveAgent(UserId.make("user-001"));
      const audit = yield* readAudit("registration-001");

      expect(created).toEqual({
        agentId: "agent-001",
        allowancePeriodId: "allowance-period-001",
        plan: "free",
        subscriptionId: "subscription-001",
        userId: "user-001",
      });
      expect(route).toEqual({ agentId: "agent-001", userId: "user-001" });
      expect(audit).toEqual({ action: "registration_established", outcome: "applied" });
    }),
  );

  it.effect("returns one registration when the same Registration arrives concurrently", () =>
    Effect.gen(function* () {
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
        [Registration.register(input), Registration.register(input)],
        { concurrency: "unbounded" },
      );
      const exactDuplicate = yield* Registration.register(input);
      const conflict = yield* Effect.flip(
        Registration.register({
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

      yield* Registration.register(first);
      const failedCreate = yield* Effect.flip(Registration.register(second));
      const missingRoute = yield* Effect.flip(AgentDirectory.resolveAgent(second.userId));
      const failedAudit = yield* readAudit("registration-route-conflict");
      const retried = yield* Registration.register({
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
      expect(failedAudit).toBeUndefined();
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

const readAudit = (operationId: string) =>
  Effect.gen(function* () {
    const db = yield* database;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ action: securityAuditFacts.action, outcome: securityAuditFacts.outcome })
          .from(securityAuditFacts)
          .where(eq(securityAuditFacts.operationId, RegistrationId.make(operationId)))
          .limit(1),
      catch: (cause) => dbUnavailable("establishRegistration", cause),
    });
    return rows[0];
  });
