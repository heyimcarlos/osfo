/* oxlint-disable effecttsgo/global-date-in-effect -- Fixed database timestamps are deterministic test evidence. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect generators. */
import { expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect, Exit, Predicate } from "effect";

import { AllowancePeriodId, ResourcePriceVersion, UserId } from "../../domain";
import { readQualificationBillingAuthority } from "./qualification-evidence";
import { recordUsage } from "./record-usage";

const userId = UserId.make("qualification-billing-user");
const allowancePeriodId = AllowancePeriodId.make("qualification-billing-period");
const priceBookId = ResourcePriceVersion.make("resource-prices-2026-08-22");

it.effect("joins accepted and model facts to the exact retained Allowance authority", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* Effect.promise(() =>
      fixture.database.insert(users).values({
        email: "qualification-billing@example.test",
        id: userId,
        name: "Qualification Billing",
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(billingSubscriptions).values({
        billing_subscription_id: "qualification-billing-subscription",
        plan: "free",
        plan_policy_version: "launch-v1",
        user_id: userId,
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(allowancePeriods).values({
        allowance_period_id: allowancePeriodId,
        billing_subscription_id: "qualification-billing-subscription",
        ends_at: new Date("2099-08-30T17:00:00.000Z"),
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: new Date("2099-08-29T17:00:00.000Z"),
        user_id: userId,
      }),
    );

    yield* recordUsage(
      fixture.database,
      allowancePeriodId,
      { sourceId: "acceptance-1", sourceType: "acceptanceReceipt" },
      [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
      userId,
    );
    yield* recordUsage(
      fixture.database,
      allowancePeriodId,
      {
        resourcePriceVersion: priceBookId,
        sourceId: "model-attempt-with-use",
        sourceType: "ModelCallAttempt",
      },
      [
        { allowanceKind: "planUsageMicros", basis: "observed", quantity: 42n },
        { allowanceKind: "vendorUsdMicros", basis: "observed", quantity: 7n },
      ],
      userId,
    );
    yield* recordUsage(
      fixture.database,
      allowancePeriodId,
      {
        resourcePriceVersion: priceBookId,
        sourceId: "model-attempt-zero",
        sourceType: "ModelCallAttempt",
      },
      [],
      userId,
    );

    const root = {
      acceptanceReceiptId: "acceptance-1",
      allowancePeriodId,
      modelCalls: [
        {
          attemptId: "model-attempt-with-use",
          costReconciliationId: "allowance:model-attempt-with-use",
          items: [
            {
              allowanceKind: "planUsageMicros" as const,
              basis: "observed" as const,
              quantity: 42n,
            },
            { allowanceKind: "vendorUsdMicros" as const, basis: "observed" as const, quantity: 7n },
          ],
          priceBookId,
        },
        {
          attemptId: "model-attempt-zero",
          costReconciliationId: "allowance:model-attempt-zero",
          items: [],
          priceBookId,
        },
      ],
      rootId: "root-1",
      userId,
    };

    const ready = yield* readQualificationBillingAuthority(fixture.database, [root]);
    expect(ready).toMatchObject({ _tag: "Ready" });
    if (Predicate.isTagged(ready, "Ready")) {
      expect(ready.localEvidence).toHaveLength(1);
      expect(ready.records).toHaveLength(4);
      expect(ready.records).toContainEqual(
        expect.objectContaining({
          basis: "provenNoUse",
          priceBookId,
          quantity: 0n,
          sourceId: "model-attempt-zero",
        }),
      );
    }

    expect(
      yield* readQualificationBillingAuthority(fixture.database, [
        {
          ...root,
          modelCalls: [
            {
              attemptId: "model-attempt-with-use",
              costReconciliationId: "allowance:model-attempt-with-use",
              items: [
                {
                  allowanceKind: "planUsageMicros" as const,
                  basis: "observed" as const,
                  quantity: 41n,
                },
              ],
              priceBookId,
            },
          ],
        },
      ]),
    ).toEqual({ _tag: "Conflict", rootId: root.rootId });
    expect(
      yield* readQualificationBillingAuthority(fixture.database, [
        {
          ...root,
          modelCalls: [
            {
              attemptId: "model-attempt-not-settled",
              costReconciliationId: "allowance:model-attempt-not-settled",
              items: [],
              priceBookId,
            },
          ],
        },
      ]),
    ).toEqual({ _tag: "Missing", rootId: root.rootId });
  }),
);

it.effect("rejects model accounting without its frozen Resource Price version", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    const exit = yield* Effect.exit(
      recordUsage(
        fixture.database,
        allowancePeriodId,
        { sourceId: "unversioned-model-attempt", sourceType: "ModelCallAttempt" },
        [],
        userId,
      ).pipe(Effect.asVoid),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);
