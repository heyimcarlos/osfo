/* oxlint-disable effecttsgo/global-date -- Fixed product timestamps make concurrent admission evidence deterministic. */
/* oxlint-disable effecttsgo/strict-effect-provide -- This integration test owns its isolated PostgreSQL-compatible database. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the @effect/vitest Effect callback. */
import { expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect, Result } from "effect";

import {
  AgentId,
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ConversationRouteId,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
  SessionId,
  UserId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { AuthSessionId } from "../../domain/auth-session";
import { ManagedModelRoute } from "../../domain/model-access-policy";
import { ResearchReport } from "../../services/research-report";
import { ResearchReportPostgres } from "./research-report";

const admittedAt = new Date("2026-08-28T12:00:00.000Z");
const periodEndsAt = new Date("2026-09-28T12:00:00.000Z");
const userId = UserId.make("concurrent-research-user");
const allowancePeriodId = AllowancePeriodId.make("concurrent-research-period");

it.effect("serializes different Workflow identities against one User capacity", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* Effect.promise(() =>
      fixture.database.insert(users).values({
        email: "concurrent-research@example.test",
        emailVerified: true,
        id: userId,
        name: "Concurrent Research",
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(billingSubscriptions).values({
        billing_subscription_id: "concurrent-research-subscription",
        plan: "free",
        plan_policy_version: "launch-v1",
        user_id: userId,
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(allowancePeriods).values({
        allowance_period_id: allowancePeriodId,
        billing_subscription_id: "concurrent-research-subscription",
        ends_at: periodEndsAt,
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: admittedAt,
        user_id: userId,
      }),
    );
    const persistence = ResearchReportPostgres.make(fixture.database);
    const results = yield* Effect.all(
      [
        persistence.admit(record("one"), 1n).pipe(Effect.result),
        persistence.admit(record("two"), 1n).pipe(Effect.result),
      ],
      { concurrency: 2 },
    );

    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    expect(results.filter(Result.isFailure)).toHaveLength(1);
    expect(results.find(Result.isFailure)).toMatchObject({
      failure: { _tag: "Denied", reason: "liveResourceLimitReached" },
    });
    const admitted = results.find(Result.isSuccess);
    if (admitted === undefined) return;
    const replay = yield* persistence.admit(admitted.success.report, 1n);
    expect(replay).toMatchObject({
      _tag: "Existing",
      report: { workflowId: admitted.success.report.workflowId },
    });
  }).pipe(Effect.scoped),
);

const record = (identity: string): ResearchReport.Record => {
  const workflowId = ResearchReport.WorkflowId.make(`research:${identity}`);
  return {
    acceptedAt: null,
    actionId: ActionId.make(`action-${identity}`),
    admittedAt,
    agentId: AgentId.make("concurrent-research-agent"),
    allowancePeriodId,
    approval: null,
    artifactContentId: null,
    artifactStoredAt: null,
    cancelRequestedAt: null,
    capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
    cloudflareInstanceId: ResearchReport.CloudflareInstanceId.make(workflowId),
    deadlineAt: new Date("2026-08-28T13:00:00.000Z"),
    inputDigest: ResearchReport.InputDigest.make((identity === "one" ? "a" : "b").repeat(64)),
    manifestVersion: null,
    modelAccessPolicyVersion: ModelAccessPolicyVersion.make("launch-v1"),
    modelRoute: ManagedModelRoute.make("@cf/deepseek-ai/deepseek-v4-flash-0731"),
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: AuthSessionId.make("concurrent-research-session"),
    },
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    request: ResearchReport.Request.make({
      consequences: [],
      format: "pdf",
      queries: [`query-${identity}`],
      topic: `topic-${identity}`,
    }),
    resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
    routeId: ConversationRouteId.make("concurrent-research-route"),
    safeFailureCode: null,
    sessionId: SessionId.make("concurrent-research-agent-session"),
    sourceManifestDigest: null,
    sourceManifestKey: null,
    startedAt: null,
    state: "admitted",
    terminalAt: null,
    userId,
    workflowId,
  };
};
