/* oxlint-disable effecttsgo/prefer-schema-over-json, osfo/no-runtime-typeof, osfo/no-unknown-parameters, typescript/consistent-return, vitest/no-standalone-expect -- This deterministic test-only recorder compares bigint allowance facts without crossing an application trust boundary. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { AllowanceItem, AllowanceSource } from "../domain/allowance";
import { PlanPolicyVersion } from "../domain";
import { ActionId } from "../domain/action-execution";
import { ScheduledEmailAccounting } from "./scheduled-email-accounting";
import { makeRecord } from "./scheduled-email-test-fixture";

it.effect("records stable launch Workflow and Gmail facts without provider cost", () => {
  const facts = new Map<string, ReadonlyArray<AllowanceItem>>();
  const accounting = ScheduledEmailAccounting.make({
    recordLegacy: (_period, source, items) => retain(facts, source, items),
  });
  const accepted = makeRecord({ state: "accepted" });
  const ambiguous = makeRecord({
    sendAccountingBasis: "conservative",
    sendOutcome: "ambiguous",
    state: "send_pending_reconciliation",
  });
  const applied = makeRecord({
    actionId: ActionId.make("scheduled-email-applied-action"),
    sendAccountingBasis: "observed",
    sendOutcome: "applied",
    state: "success",
  });

  return Effect.gen(function* () {
    yield* accounting.recordWorkflowStart(accepted);
    yield* accounting.recordWorkflowStart(accepted);
    yield* accounting.recordSendOutcome(ambiguous);
    yield* accounting.recordSendOutcome(applied);

    expect([...facts.values()].flat()).toEqual([
      { allowanceKind: "workflowStarts", basis: "known_at_start", quantity: 1n },
      { allowanceKind: "gmailSends", basis: "conservative", quantity: 1n },
      { allowanceKind: "gmailSends", basis: "observed", quantity: 1n },
    ]);
    expect(
      [...facts.values()].flat().some(({ allowanceKind }) => allowanceKind === "vendorUsdMicros"),
    ).toBe(false);
  });
});

it.effect("does not create a zero-cost shared Usage charge or a NotApplied Gmail fact", () => {
  const facts = new Map<string, ReadonlyArray<AllowanceItem>>();
  const accounting = ScheduledEmailAccounting.make({
    recordLegacy: (_period, source, items) => retain(facts, source, items),
  });
  const shared = makeRecord({
    planPolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
    sendAccountingBasis: "observed",
    sendOutcome: "applied",
    state: "success",
  });
  const notApplied = makeRecord({ sendOutcome: "notApplied", state: "failure" });

  return Effect.gen(function* () {
    yield* accounting.recordWorkflowStart(shared);
    yield* accounting.recordSendOutcome(shared);
    yield* accounting.recordSendOutcome(notApplied);
    expect(facts.size).toBe(0);
  });
});

const retain = (
  facts: Map<string, ReadonlyArray<AllowanceItem>>,
  source: AllowanceSource,
  items: ReadonlyArray<AllowanceItem>,
) =>
  Effect.gen(function* () {
    const key = `${source.sourceType}:${source.sourceId}`;
    const current = facts.get(key);
    if (
      current !== undefined &&
      JSON.stringify(current, bigintJson) !== JSON.stringify(items, bigintJson)
    ) {
      return yield* new ScheduledEmailAccounting.PersistenceUnavailable({ cause: "changed facts" });
    }
    if (current === undefined) facts.set(key, items);
  });

const bigintJson = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;
