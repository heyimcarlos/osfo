/* oxlint-disable effecttsgo/global-date-in-effect -- Fixed Scheduled Email timestamps make authority projection deterministic. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect generators. */
import { expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { scheduledEmails } from "@osfo/db/schema/scheduled-emails";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect } from "effect";

import { canonicalQualificationJson } from "../../qualification/qualification-checksum";
import { readQualificationScheduledEmailAuthority } from "./scheduled-email";

it.effect("reads only the exact transactionally retained Scheduled Email root", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* Effect.promise(() =>
      fixture.database.insert(users).values({
        email: "qualification-scheduled@example.test",
        id: "qualification-scheduled-user",
        name: "Qualification Scheduled",
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(billingSubscriptions).values({
        billing_subscription_id: "qualification-scheduled-subscription",
        plan: "free",
        plan_policy_version: "launch-v1",
        user_id: "qualification-scheduled-user",
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(allowancePeriods).values({
        allowance_period_id: "qualification-scheduled-period",
        billing_subscription_id: "qualification-scheduled-subscription",
        ends_at: new Date("2099-08-31T00:00:00.000Z"),
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: new Date("2099-08-29T00:00:00.000Z"),
        user_id: "qualification-scheduled-user",
      }),
    );
    const qualificationContext = {
      attemptId: "qualification-scheduled-attempt",
      executionId: "qualification-scheduled-execution",
      journey: "scheduledEmail" as const,
      offeredAtEpochMs: Date.parse("2099-08-29T16:00:00.000Z"),
      planChecksum: "qualification-scheduled-plan",
      region: "americas" as const,
      rootId: "qualification-scheduled-root",
      runId: "qualification-scheduled-run",
    };
    const admittedAt = new Date("2099-08-29T16:00:00.000Z");
    const dueAt = new Date("2099-08-29T17:00:00.000Z");
    const sendOutcomeAt = new Date("2099-08-29T17:01:00.000Z");
    const terminalAt = new Date("2099-08-29T17:02:00.000Z");
    yield* Effect.promise(() =>
      fixture.database.insert(scheduledEmails).values({
        accepted_at: new Date("2099-08-29T16:01:00.000Z"),
        action_id: "qualification-scheduled-action",
        admitted_at: admittedAt,
        agent_id: "qualification-scheduled-agent",
        allowance_period_id: "qualification-scheduled-period",
        approval_presentation: "{}",
        capability_catalog_version: "launch-v1",
        cloudflare_instance_id: "qualification-scheduled-instance",
        due_at: dueAt,
        input_digest: "a".repeat(64),
        manifest_version: "gmail-v1",
        model_access_policy_version: "launch-v1",
        model_route: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        originating_authority_json: canonicalQualificationJson({
          _tag: "DurableTrigger",
          triggerId: "qualification-scheduled-attempt",
          triggerType: "workflow",
        }),
        plan: "free",
        plan_policy_version: "launch-v1",
        provider_log_id: "qualification-provider-log",
        provider_resource_id: "qualification-gmail-message",
        qualification_context_json: canonicalQualificationJson(qualificationContext),
        request_json: canonicalQualificationJson({
          body: "Qualification body",
          gmailResource: "primary",
          recipients: ["recipient@example.test"],
          scheduledAt: dueAt.toISOString(),
          subject: "Qualification subject",
        }),
        resource_price_version: "resource-prices-2026-08-22",
        route_id: "qualification-scheduled-route",
        send_accounted_at: terminalAt,
        send_accounting_basis: "observed",
        send_claim_generation: 1,
        send_outcome: "applied",
        send_outcome_at: sendOutcomeAt,
        send_started_at: dueAt,
        session_id: "qualification-scheduled-session",
        state: "success",
        terminal_at: terminalAt,
        user_id: "qualification-scheduled-user",
        waiting_at: new Date("2099-08-29T16:02:00.000Z"),
        workflow_id: "qualification-scheduled-workflow",
        workflow_start_accounted_at: new Date("2099-08-29T16:03:00.000Z"),
      }),
    );

    expect(
      yield* readQualificationScheduledEmailAuthority(
        fixture.database,
        qualificationContext.executionId,
        [qualificationContext.rootId],
      ),
    ).toMatchObject({
      _tag: "Ready",
      records: [
        {
          providerLogId: "qualification-provider-log",
          providerResourceId: "qualification-gmail-message",
          qualificationContext,
          state: "success",
        },
      ],
    });
    expect(
      yield* readQualificationScheduledEmailAuthority(
        fixture.database,
        qualificationContext.executionId,
        ["missing-root"],
      ),
    ).toEqual({ _tag: "Missing", rootId: "missing-root" });
  }),
);
