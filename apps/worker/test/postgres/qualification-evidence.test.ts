import { env } from "cloudflare:workers";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Db } from "../../src/db";
import { readQualificationAcceptanceEvidence } from "../../src/db/billing";
import { AllowancePeriodId, UserId } from "../../src/domain";

/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/strict-effect-provide -- This PostgreSQL contract test is the concrete database Layer entry point. */

it.effect("exports only requested acceptance Allowance rows as PostgreSQL authority evidence", () =>
  Effect.gen(function* () {
    const database = yield* Db.database;
    const userId = UserId.make("qualification-evidence-user");
    const allowancePeriodId = AllowancePeriodId.make("qualification-evidence-period");
    yield* Effect.promise(() =>
      database.insert(users).values({
        email: "qualification-evidence@example.test",
        emailVerified: true,
        id: userId,
        name: "Qualification Evidence",
      }),
    );
    yield* Effect.promise(() =>
      database.insert(billingSubscriptions).values({
        billing_subscription_id: "qualification-evidence-subscription",
        plan: "free",
        plan_policy_version: "launch-v1",
        user_id: userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(allowancePeriods).values({
        allowance_period_id: allowancePeriodId,
        billing_subscription_id: "qualification-evidence-subscription",
        ends_at: new Date("2026-09-01T00:00:00.000Z"),
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: new Date("2026-08-01T00:00:00.000Z"),
        user_id: userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(allowanceUsage).values([
        {
          allowance_kind: "acceptedMessages",
          allowance_period_id: allowancePeriodId,
          basis: "known_at_start",
          quantity: 1n,
          source_id: "telegram:message-1",
          source_type: "acceptanceReceipt",
          user_id: userId,
        },
        {
          allowance_kind: "acceptedMessages",
          allowance_period_id: allowancePeriodId,
          basis: "known_at_start",
          quantity: 1n,
          source_id: "telegram:message-2",
          source_type: "acceptanceReceipt",
          user_id: userId,
        },
      ]),
    );

    const evidence = yield* readQualificationAcceptanceEvidence(database, [
      { acceptanceReceiptId: "telegram:message-1", allowancePeriodId },
    ]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      acceptanceReceiptId: "telegram:message-1",
      allowanceConsumptionId:
        "qualification-evidence-period:acceptedMessages:acceptanceReceipt:telegram:message-1",
      authority: "allowance_usage",
      productFactId:
        "qualification-evidence-period:acceptedMessages:acceptanceReceipt:telegram:message-1",
      store: "PostgreSQL",
    });
    expect(Date.parse(evidence[0]?.occurredAt ?? "")).not.toBeNaN();
  }).pipe(Effect.provide(Db.layer({ db: env.DB }))),
);
