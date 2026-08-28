/* oxlint-disable effecttsgo/global-date -- Fixed product timestamps make concurrent admission evidence deterministic. */
/* oxlint-disable effecttsgo/strict-effect-provide -- This integration test owns its isolated PostgreSQL-compatible database. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the @effect/vitest Effect callback. */
/* oxlint-disable eslint/no-underscore-dangle -- Follow-up outcomes use Effect's canonical _tag discriminator. */
import { expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import {
  researchReportNotifications,
  researchReportProviderOperations,
  researchReports,
  researchReportSynthesisOperations,
} from "@osfo/db/schema/research-reports";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
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
import { ResearchReportFollowUp } from "../../services/research-report-follow-up";
import { ResearchReportFollowUpPostgres } from "./research-report-follow-up";
import { ResearchReportPostgres } from "./research-report";

const admittedAt = new Date("2026-08-28T12:00:00.000Z");
const periodEndsAt = new Date("2026-09-28T12:00:00.000Z");
const executionStartedAt = new Date("2026-08-28T12:05:00.000Z");
const artifactStoredAt = new Date("2026-08-28T12:10:00.000Z");
const deletionCompletedAt = new Date("2026-08-28T12:15:00.000Z");
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

it.effect("cancels a report after artifact retention and rejects late publication", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const persistence = ResearchReportPostgres.make(fixture.database);
    const retained = yield* retainArtifact(persistence, "retained-cancel");

    const requested = yield* persistence.requestCancel(
      retained.workflowId,
      retained.userId,
      deletionCompletedAt,
    );
    expect(requested).toMatchObject({ state: "cancel_requested" });
    const canceled = yield* persistence.finishTerminal(
      retained.workflowId,
      retained.inputDigest,
      "canceled",
      "cancel-requested",
      deletionCompletedAt,
    );
    expect(canceled).toMatchObject({ safeFailureCode: "cancel-requested", state: "canceled" });
    const lateCommit = yield* persistence
      .commitArtifactPublication(
        retained.workflowId,
        retained.inputDigest,
        retained.artifactContentId ?? "missing",
        deletionCompletedAt,
      )
      .pipe(Effect.result);
    expect(lateCommit).toMatchObject({ failure: { _tag: "ResearchReportConflict" } });
    const lateSuccess = yield* persistence
      .completeSuccess(
        retained.workflowId,
        retained.inputDigest,
        retained.artifactContentId ?? "missing",
        deletionCompletedAt,
      )
      .pipe(Effect.result);
    expect(lateSuccess).toMatchObject({ failure: { _tag: "ResearchReportConflict" } });
  }).pipe(Effect.scoped),
);

it.effect("serializes publication commit against cancellation after artifact retention", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const persistence = ResearchReportPostgres.make(fixture.database);
    const retained = yield* retainArtifact(persistence, "publication-race");
    const contentId = retained.artifactContentId ?? "missing";

    const [cancellation, publication] = yield* Effect.all(
      [
        Effect.gen(function* () {
          const requested = yield* persistence.requestCancel(
            retained.workflowId,
            retained.userId,
            deletionCompletedAt,
          );
          if (requested.state !== "cancel_requested") return requested;
          return yield* persistence.finishTerminal(
            retained.workflowId,
            retained.inputDigest,
            "canceled",
            "cancel-requested",
            deletionCompletedAt,
          );
        }).pipe(Effect.result),
        persistence
          .commitArtifactPublication(
            retained.workflowId,
            retained.inputDigest,
            contentId,
            deletionCompletedAt,
          )
          .pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    const winner = yield* persistence.inspect(retained.workflowId);
    expect(winner?.state === "publication_committed" || winner?.state === "canceled").toBe(true);
    if (winner?.state === "publication_committed") {
      expect(publication).toMatchObject({ success: { state: "publication_committed" } });
      expect(cancellation).toMatchObject({ success: { state: "publication_committed" } });
      const completed = yield* persistence.completeSuccess(
        retained.workflowId,
        retained.inputDigest,
        contentId,
        deletionCompletedAt,
      );
      expect(completed).toMatchObject({ state: "success" });
    } else {
      expect(cancellation).toMatchObject({ success: { state: "canceled" } });
      expect(publication).toMatchObject({ failure: { _tag: "ResearchReportConflict" } });
    }
  }).pipe(Effect.scoped),
);

it.effect("claims terminal follow-up exactly once only after publication finalizes", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const persistence = ResearchReportPostgres.make(fixture.database);
    const retained = yield* retainArtifact(persistence, "follow-up-publication");
    const contentId = retained.artifactContentId ?? "missing";
    const committed = yield* persistence.commitArtifactPublication(
      retained.workflowId,
      retained.inputDigest,
      contentId,
      artifactStoredAt,
    );
    const payload = ResearchReport.WorkflowPayload.make({
      inputDigest: retained.inputDigest,
      workflowId: retained.workflowId,
    });
    const followUps = ResearchReportFollowUpPostgres.make(fixture.database);

    expect(yield* followUps.claimTerminal(payload, artifactStoredAt)).toEqual({
      _tag: "NotTerminal",
    });
    yield* persistence.completeSuccess(
      committed.workflowId,
      committed.inputDigest,
      contentId,
      deletionCompletedAt,
    );
    const first = yield* followUps.claimTerminal(payload, deletionCompletedAt);
    const replay = yield* followUps.claimTerminal(payload, deletionCompletedAt);
    expect(first).toMatchObject({ _tag: "Claimed" });
    if (first._tag !== "Claimed") return;
    expect(replay).toMatchObject({
      _tag: "AlreadyClaimed",
      notification: { notificationId: first.notification.notificationId },
    });
    expect(yield* Effect.promise(() => countRows(fixture.database))).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("lists only bounded delivered Research Report notifications for the owning User", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const persistence = ResearchReportPostgres.make(fixture.database);
    const admitted = yield* persistence.admit(record("dashboard"), 10n);
    yield* Effect.promise(() =>
      fixture.database
        .update(researchReports)
        .set({
          accepted_at: executionStartedAt,
          artifact_content_id: "document:workflow:research:dashboard",
          artifact_stored_at: artifactStoredAt,
          publication_committed_at: artifactStoredAt,
          manifest_version: "research-manifest-v1",
          source_manifest_digest: "d".repeat(64),
          source_manifest_key:
            "users/concurrent-research-user/research-report/manifests/dashboard.json",
          started_at: executionStartedAt,
          state: "success",
          terminal_at: deletionCompletedAt,
        })
        .where(eq(researchReports.workflow_id, admitted.report.workflowId)),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(researchReportNotifications).values({
        claimed_at: artifactStoredAt,
        delivered_at: deletionCompletedAt,
        kind: "terminal",
        notification_id: "notification-dashboard",
        think_submission_id: "submission-dashboard",
        user_id: userId,
        workflow_id: admitted.report.workflowId,
      }),
    );
    const followUps = ResearchReportFollowUpPostgres.make(fixture.database);

    expect(yield* followUps.deliveredForUser(userId)).toMatchObject([
      {
        acceptedAt: deletionCompletedAt,
        artifactContentId: "document:workflow:research:dashboard",
        kind: "terminal",
        reportState: "success",
        safeFailureCode: null,
        workflowId: admitted.report.workflowId,
      },
    ]);
    expect(yield* followUps.deliveredForUser(UserId.make("another-user"))).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("fences admission, terminalizes every private Workflow, and cascades child truth", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const persistence = ResearchReportPostgres.make(fixture.database);
    const admitted = yield* persistence.admit(record("deleting-admitted"), 10n);
    const running = yield* persistence.admit(record("deleting-running"), 10n);
    const artifact = yield* persistence.admit(record("deleting-artifact"), 10n);
    const success = yield* persistence.admit(record("deleting-success"), 10n);
    yield* Effect.promise(() =>
      fixture.database
        .update(researchReports)
        .set({
          accepted_at: executionStartedAt,
          started_at: executionStartedAt,
          state: "running",
        })
        .where(eq(researchReports.workflow_id, running.report.workflowId)),
    );
    yield* Effect.promise(() =>
      fixture.database
        .update(researchReports)
        .set({
          accepted_at: executionStartedAt,
          artifact_content_id: "artifact:deleting",
          artifact_stored_at: artifactStoredAt,
          manifest_version: "research-manifest-v1",
          source_manifest_digest: "c".repeat(64),
          source_manifest_key: "users/concurrent-research-user/research/deleting/manifest.json",
          started_at: executionStartedAt,
          state: "artifact_stored",
        })
        .where(eq(researchReports.workflow_id, artifact.report.workflowId)),
    );
    yield* Effect.promise(() =>
      fixture.database
        .update(researchReports)
        .set({
          accepted_at: executionStartedAt,
          artifact_content_id: "artifact:success",
          artifact_stored_at: artifactStoredAt,
          publication_committed_at: artifactStoredAt,
          manifest_version: "research-manifest-v1",
          source_manifest_digest: "d".repeat(64),
          source_manifest_key: "users/concurrent-research-user/research/success/manifest.json",
          started_at: executionStartedAt,
          state: "success",
          terminal_at: deletionCompletedAt,
        })
        .where(eq(researchReports.workflow_id, success.report.workflowId)),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(deletionCases).values({
        access_fenced_at: deletionCompletedAt,
        approval_action_id: "delete-action",
        approval_presentation: "Delete Account",
        deletion_case_id: "delete-case",
        reason: "User requested account deletion",
        requested_by_user_id: userId,
        user_id: userId,
      }),
    );

    const denied = yield* persistence.admit(record("late-after-fence"), 10n).pipe(Effect.result);
    expect(denied).toMatchObject({
      failure: { _tag: "Denied", reason: "deletionAccessRevoked" },
    });

    const instanceIds = yield* ResearchReportPostgres.quiesceForAccountDeletion(
      fixture.database,
      userId,
      deletionCompletedAt,
    );
    expect(new Set(instanceIds)).toEqual(
      new Set([
        admitted.report.cloudflareInstanceId,
        running.report.cloudflareInstanceId,
        artifact.report.cloudflareInstanceId,
        success.report.cloudflareInstanceId,
      ]),
    );
    expect(yield* persistence.inspect(admitted.report.workflowId)).toMatchObject({
      safeFailureCode: "account-deletion",
      state: "canceled",
    });
    expect(yield* persistence.inspect(running.report.workflowId)).toMatchObject({
      safeFailureCode: "account-deletion",
      state: "canceled",
    });
    expect(yield* persistence.inspect(artifact.report.workflowId)).toMatchObject({
      safeFailureCode: "account-deletion",
      state: "canceled",
    });
    expect(yield* persistence.inspect(success.report.workflowId)).toMatchObject({
      safeFailureCode: null,
      state: "success",
    });
    expect(
      yield* ResearchReportPostgres.quiesceForAccountDeletion(
        fixture.database,
        userId,
        deletionCompletedAt,
      ),
    ).toEqual(instanceIds);

    const followUps = ResearchReportFollowUpPostgres.make(fixture.database);
    const payload = ResearchReport.WorkflowPayload.make({
      inputDigest: admitted.report.inputDigest,
      workflowId: admitted.report.workflowId,
    });
    expect(yield* followUps.claimMilestone(payload, deletionCompletedAt)).toEqual({
      _tag: "Suppressed",
    });
    expect(yield* followUps.claimTerminal(payload, deletionCompletedAt)).toEqual({
      _tag: "Suppressed",
    });
    expect(yield* Effect.promise(() => countRows(fixture.database))).toBe(0);

    yield* Effect.promise(() =>
      fixture.database.insert(researchReportProviderOperations).values({
        input_digest: "e".repeat(64),
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This trusted test fixture proves row-cascade ownership, not JSON decoding.
        input_json: JSON.stringify({ query: "private" }),
        kind: "search",
        operation_id: "provider-private",
        sequence: 0,
        state: "pending",
        workflow_id: admitted.report.workflowId,
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(researchReportSynthesisOperations).values({
        input_digest: "f".repeat(64),
        model_access_policy_version: "launch-v1",
        model_route: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        operation_id: "synthesis-private",
        resource_price_version: "resource-prices-2026-08-22",
        state: "pending",
        workflow_id: admitted.report.workflowId,
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(researchReportNotifications).values({
        claimed_at: deletionCompletedAt,
        kind: "terminal",
        notification_id: "notification-private",
        user_id: userId,
        workflow_id: admitted.report.workflowId,
      }),
    );
    expect(
      yield* followUps.inspect(ResearchReportFollowUp.NotificationId.make("notification-private")),
    ).toBeNull();
    yield* Effect.promise(() => fixture.database.delete(users).where(eq(users.id, userId)));
    const privateRows = yield* Effect.promise(() =>
      Promise.all([
        fixture.database.select().from(researchReports),
        fixture.database.select().from(researchReportProviderOperations),
        fixture.database.select().from(researchReportSynthesisOperations),
        fixture.database.select().from(researchReportNotifications),
      ]),
    );
    expect(privateRows.every((rows) => rows.length === 0)).toBe(true);
  }).pipe(Effect.scoped),
);

const seedUser = (database: Parameters<typeof ResearchReportPostgres.make>[0]) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      database.insert(users).values({
        email: "concurrent-research@example.test",
        emailVerified: true,
        id: userId,
        name: "Concurrent Research",
      }),
    );
    yield* Effect.promise(() =>
      database.insert(billingSubscriptions).values({
        billing_subscription_id: "concurrent-research-subscription",
        plan: "free",
        plan_policy_version: "launch-v1",
        user_id: userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(allowancePeriods).values({
        allowance_period_id: allowancePeriodId,
        billing_subscription_id: "concurrent-research-subscription",
        ends_at: periodEndsAt,
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: admittedAt,
        user_id: userId,
      }),
    );
  });

const retainArtifact = (
  persistence: ResearchReport.PortInterface["persistence"],
  identity: string,
) =>
  Effect.gen(function* () {
    const admitted = yield* persistence.admit(record(identity), 10n);
    const accepted = yield* persistence.markAccepted(
      admitted.report.workflowId,
      admitted.report.inputDigest,
      executionStartedAt,
    );
    yield* persistence.beginExecution(
      accepted.workflowId,
      accepted.inputDigest,
      executionStartedAt,
    );
    yield* persistence.markSourcesCommitted(
      accepted.workflowId,
      accepted.inputDigest,
      `users/${accepted.userId}/research-report/manifests/${identity}.json`,
      ResearchReport.InputDigest.make("c".repeat(64)),
      executionStartedAt,
    );
    return yield* persistence.claimArtifactPublication(
      accepted.workflowId,
      accepted.inputDigest,
      `document:workflow:${accepted.workflowId}`,
      artifactStoredAt,
    );
  });

const countRows = (database: Parameters<typeof ResearchReportPostgres.make>[0]) =>
  database
    .select()
    .from(researchReportNotifications)
    .then((rows) => rows.length);

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
    publicationCommittedAt: null,
    cancelRequestedAt: null,
    capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
    cloudflareInstanceId: ResearchReport.CloudflareInstanceId.make(`research-${identity}`),
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
