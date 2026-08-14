import { env } from "cloudflare:test";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";

import { DbTimestamp, layer as dbLayer } from "../src/db";
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

const databaseLayer = dbLayer({ db: env.DB });

layer(databaseLayer)("Db", (it) => {
  it.effect("atomically establishes registration and stable Agent routing", () =>
    Effect.gen(function* () {
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
      expect(failedAudit).toBeNull();
      expect(retried.userId).toBe("user-route-conflict");
    }),
  );
});

const readAudit = (operationId: string) =>
  Effect.promise(() =>
    env.DB.prepare("SELECT action, outcome FROM security_audit_facts WHERE operation_id = ?")
      .bind(operationId)
      .first<{ readonly action: string; readonly outcome: string }>(),
  );
