/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed timestamps make persistence evidence deterministic. */
/* oxlint-disable effecttsgo/strict-effect-provide -- This test owns its isolated PostgreSQL database. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect test callback. */
import { expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { documentBuildNotifications, documentBuilds } from "@osfo/db/schema/document-builds";
import { researchReportNotifications, researchReports } from "@osfo/db/schema/research-reports";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect } from "effect";

import type { Database } from "@osfo/db";
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
import { FileDigest } from "../../domain/file-content";
import { FileId } from "../../domain/file";
import { ManagedModelRoute } from "../../domain/model-access-policy";
import { DocumentBuild } from "../../services/document-build";
import { DocumentBuildFollowUpPostgres } from "./document-build-follow-up";
import { DocumentBuildPostgres } from "./document-build";

const admittedAt = new Date("2026-08-28T12:00:00.000Z");
const userId = UserId.make("document-build-user");
const allowancePeriodId = AllowancePeriodId.make("document-build-period");

it.effect("retains one exact request and serializes preview publication against cancellation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* Effect.promise(() =>
      fixture.database.insert(users).values({
        email: "document-build@example.test",
        emailVerified: true,
        id: userId,
        name: "Document Build",
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(billingSubscriptions).values({
        billing_subscription_id: "document-build-subscription",
        plan: "free",
        plan_policy_version: "launch-v1",
        user_id: userId,
      }),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(allowancePeriods).values({
        allowance_period_id: allowancePeriodId,
        billing_subscription_id: "document-build-subscription",
        ends_at: new Date("2026-09-28T12:00:00.000Z"),
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: admittedAt,
        user_id: userId,
      }),
    );

    const persistence = DocumentBuildPostgres.make(fixture.database);
    const exact = record("a");
    expect(yield* persistence.admit(exact, 3n)).toMatchObject({
      _tag: "Created",
      build: { inputDigest: exact.inputDigest, request: exact.request },
    });
    expect(yield* persistence.admit(exact, 3n)).toMatchObject({ _tag: "Existing" });
    const changed = yield* persistence
      .admit({ ...exact, inputDigest: DocumentBuild.InputDigest.make("b".repeat(64)) }, 3n)
      .pipe(Effect.result);
    expect(changed).toMatchObject({ failure: { _tag: "DocumentBuildConflict" } });

    const accepted = yield* persistence.markAccepted(
      exact.workflowId,
      exact.inputDigest,
      admittedAt,
    );
    const running = yield* persistence.beginExecution(
      exact.workflowId,
      exact.inputDigest,
      admittedAt,
    );
    expect(accepted.state).toBe("accepted");
    expect(running.state).toBe("running");
    const contentId = `document:workflow:${exact.workflowId}`;
    const preview = yield* persistence.markPreviewStored(
      exact.workflowId,
      exact.inputDigest,
      contentId,
      admittedAt,
    );
    expect(preview).toMatchObject({ artifactContentId: contentId, state: "preview_stored" });
    const canceled = yield* persistence.requestCancel(exact.workflowId, exact.userId, admittedAt);
    expect(canceled.state).toBe("cancel_requested");
    const latePublication = yield* persistence
      .commitPublication(exact.workflowId, exact.inputDigest, contentId, admittedAt)
      .pipe(Effect.result);
    expect(latePublication).toMatchObject({ failure: { _tag: "DocumentBuildConflict" } });

    const publicationWinner = record("d", "publication-winner");
    yield* persistence.admit(publicationWinner, 3n);
    yield* persistence.markAccepted(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      admittedAt,
    );
    yield* persistence.beginExecution(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      admittedAt,
    );
    const winnerContentId = `document:workflow:${publicationWinner.workflowId}`;
    yield* persistence.markPreviewStored(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      winnerContentId,
      admittedAt,
    );
    yield* persistence.markAccountingCommitted(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      winnerContentId,
      {
        _tag: "Incurred",
        allowancePeriodId,
        basis: "observed",
        providerOperationId: "document-build-publication-winner",
        usdMicros: 25n,
      },
      admittedAt,
    );
    const published = yield* persistence.commitPublication(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      winnerContentId,
      admittedAt,
    );
    const losingCancel = yield* persistence.requestCancel(
      publicationWinner.workflowId,
      publicationWinner.userId,
      admittedAt,
    );
    expect(published.state).toBe("publication_committed");
    expect(losingCancel.state).toBe("publication_committed");
  }).pipe(Effect.scoped),
);

it.effect("claims preview and terminal follow-ups exactly once and suppresses late previews", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const persistence = DocumentBuildPostgres.make(fixture.database);
    const followUps = DocumentBuildFollowUpPostgres.make(fixture.database);
    const previewAt = new Date("2026-08-28T12:16:00.000Z");
    const terminalAt = new Date("2026-08-28T12:17:00.000Z");
    const build = record("e", "follow-up");
    yield* persistence.admit(build, 10n);
    yield* persistence.markAccepted(build.workflowId, build.inputDigest, admittedAt);
    yield* persistence.beginExecution(build.workflowId, build.inputDigest, admittedAt);
    const contentId = `document:workflow:${build.workflowId}`;
    yield* persistence.markPreviewStored(build.workflowId, build.inputDigest, contentId, previewAt);
    const payload = payloadFor(build);

    const preview = yield* followUps.claimPreview(payload, previewAt);
    const previewReplay = yield* followUps.claimPreview(payload, previewAt);
    expect(preview).toMatchObject({ _tag: "Claimed" });
    expect(previewReplay).toMatchObject({
      _tag: "AlreadyClaimed",
      notification: { notificationId: `${build.workflowId}-preview` },
    });

    yield* persistence.markAccountingCommitted(
      build.workflowId,
      build.inputDigest,
      contentId,
      {
        _tag: "Incurred",
        allowancePeriodId,
        basis: "observed",
        providerOperationId: "document-build-follow-up",
        usdMicros: 25n,
      },
      terminalAt,
    );
    yield* persistence.commitPublication(
      build.workflowId,
      build.inputDigest,
      contentId,
      terminalAt,
    );
    yield* persistence.finishSuccess(build.workflowId, build.inputDigest, contentId, terminalAt);
    const terminal = yield* followUps.claimTerminal(payload, terminalAt);
    const terminalReplay = yield* followUps.claimTerminal(payload, terminalAt);
    expect(terminal).toMatchObject({ _tag: "Claimed" });
    expect(terminalReplay).toMatchObject({
      _tag: "AlreadyClaimed",
      notification: { notificationId: `${build.workflowId}-terminal` },
    });

    const late = record("f", "late-preview");
    yield* persistence.admit(late, 10n);
    yield* persistence.markAccepted(late.workflowId, late.inputDigest, admittedAt);
    yield* persistence.beginExecution(late.workflowId, late.inputDigest, admittedAt);
    yield* persistence.finishTerminal(
      late.workflowId,
      late.inputDigest,
      "failure",
      "provider-failed",
      terminalAt,
    );
    expect(yield* followUps.claimPreview(payloadFor(late), terminalAt)).toEqual({
      _tag: "Terminal",
    });
  }).pipe(Effect.scoped),
);

it.effect("shares the three-per-day milestone cap with Research Reports", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const persistence = DocumentBuildPostgres.make(fixture.database);
    const followUps = DocumentBuildFollowUpPostgres.make(fixture.database);
    const previewAt = new Date("2026-08-28T12:16:00.000Z");
    const build = record("7", "shared-milestone-limit");
    yield* persistence.admit(build, 10n);
    yield* persistence.markAccepted(build.workflowId, build.inputDigest, admittedAt);
    yield* persistence.beginExecution(build.workflowId, build.inputDigest, admittedAt);
    yield* persistence.markPreviewStored(
      build.workflowId,
      build.inputDigest,
      `document:workflow:${build.workflowId}`,
      previewAt,
    );
    const reports = Array.from({ length: 3 }, (_, index) => ({
      action_id: `research-action-${index}`,
      admitted_at: admittedAt,
      agent_id: "document-build-agent",
      allowance_period_id: allowancePeriodId,
      capability_catalog_version: "governed-capabilities-v1",
      cloudflare_instance_id: `research-shared-cap-${index}`,
      deadline_at: new Date("2026-08-28T13:00:00.000Z"),
      input_digest: `${index + 1}`.repeat(64),
      model_access_policy_version: "launch-v1",
      model_route: "@cf/deepseek-ai/deepseek-v4-flash-0731",
      originating_authority_json: JSON.stringify({
        _tag: "AuthSession",
        authSessionId: "document-build-auth-session",
      }),
      plan_policy_version: "launch-v1",
      request_json: JSON.stringify({ topic: `shared cap ${index}` }),
      resource_price_version: "resource-prices-2026-08-22",
      route_id: "document-build-route",
      session_id: "document-build-session",
      state: "admitted" as const,
      user_id: userId,
      workflow_id: `research:shared-cap-${index}`,
    }));
    yield* Effect.promise(() => fixture.database.insert(researchReports).values(reports));
    yield* Effect.promise(() =>
      fixture.database.insert(researchReportNotifications).values(
        reports.map((report, index) => ({
          claimed_at: new Date(previewAt.getTime() - index * 60_000),
          kind: "sourcesCollected" as const,
          notification_id: `research-shared-cap-${index}`,
          user_id: userId,
          workflow_id: report.workflow_id,
        })),
      ),
    );

    const first = yield* followUps.claimPreview(payloadFor(build), previewAt);
    const replay = yield* followUps.claimPreview(payloadFor(build), previewAt);
    expect(first).toEqual({ _tag: "Suppressed" });
    expect(replay).toEqual({ _tag: "AlreadyClaimed", notification: null });
  }).pipe(Effect.scoped),
);

it.effect("quiesces deletion-fenced builds and cascades private follow-up truth", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const persistence = DocumentBuildPostgres.make(fixture.database);
    const followUps = DocumentBuildFollowUpPostgres.make(fixture.database);
    const previewAt = new Date("2026-08-28T12:16:00.000Z");
    const build = record("8", "deletion");
    yield* persistence.admit(build, 10n);
    yield* persistence.markAccepted(build.workflowId, build.inputDigest, admittedAt);
    yield* persistence.beginExecution(build.workflowId, build.inputDigest, admittedAt);
    yield* persistence.markPreviewStored(
      build.workflowId,
      build.inputDigest,
      `document:workflow:${build.workflowId}`,
      previewAt,
    );
    expect(yield* followUps.claimPreview(payloadFor(build), previewAt)).toMatchObject({
      _tag: "Claimed",
    });
    yield* Effect.promise(() =>
      fixture.database.insert(deletionCases).values({
        access_fenced_at: previewAt,
        approval_action_id: "document-build-delete-action",
        approval_presentation: "Delete Account",
        deletion_case_id: "document-build-delete-case",
        reason: "User requested account deletion",
        requested_by_user_id: userId,
        user_id: userId,
      }),
    );

    const instances = yield* DocumentBuildPostgres.quiesceForAccountDeletion(
      fixture.database,
      userId,
      previewAt,
    );
    expect(instances).toEqual([
      { main: build.cloudflareInstanceId, timer: build.cloudflareTimerInstanceId },
    ]);
    expect(yield* persistence.inspect(build.workflowId)).toMatchObject({
      safeFailureCode: "account-deletion",
      state: "canceled",
    });
    expect(yield* followUps.claimPreview(payloadFor(build), previewAt)).toEqual({
      _tag: "Suppressed",
    });
    expect(yield* followUps.claimTerminal(payloadFor(build), previewAt)).toEqual({
      _tag: "Suppressed",
    });

    yield* Effect.promise(() => fixture.database.delete(users));
    expect(yield* Effect.promise(() => fixture.database.select().from(documentBuilds))).toEqual([]);
    expect(
      yield* Effect.promise(() => fixture.database.select().from(documentBuildNotifications)),
    ).toEqual([]);
  }).pipe(Effect.scoped),
);

const seedUser = (database: Database) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      database.insert(users).values({
        email: "document-build-follow-up@example.test",
        emailVerified: true,
        id: userId,
        name: "Document Build",
      }),
    );
    yield* Effect.promise(() =>
      database.insert(billingSubscriptions).values({
        billing_subscription_id: "document-build-subscription",
        plan: "free",
        plan_policy_version: "launch-v1",
        user_id: userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(allowancePeriods).values({
        allowance_period_id: allowancePeriodId,
        billing_subscription_id: "document-build-subscription",
        ends_at: new Date("2026-09-28T12:00:00.000Z"),
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: admittedAt,
        user_id: userId,
      }),
    );
  });

const payloadFor = (build: DocumentBuild.Record) =>
  DocumentBuild.WorkflowPayload.make({
    inputDigest: build.inputDigest,
    workflowId: build.workflowId,
  });

const record = (digest: string, identity = "test"): DocumentBuild.Record => {
  const workflowId = DocumentBuild.WorkflowId.make(`document-build:${identity}`);
  return {
    acceptedAt: null,
    accountingCommittedAt: null,
    actionId: ActionId.make("document-build-action"),
    admittedAt,
    agentId: AgentId.make("document-build-agent"),
    allowancePeriodId,
    artifactAccountedAt: null,
    artifactContentId: null,
    cancelRequestedAt: null,
    capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
    cloudflareInstanceId: DocumentBuild.CloudflareInstanceId.make(`document-build-${identity}`),
    cloudflareTimerInstanceId: DocumentBuild.CloudflareInstanceId.make(
      `document-build-${identity}-timer`,
    ),
    costEvidence: null,
    deadlineAt: new Date("2026-08-28T13:00:00.000Z"),
    inputDigest: DocumentBuild.InputDigest.make(digest.repeat(64)),
    manifestVersion: null,
    modelAccessPolicyVersion: ModelAccessPolicyVersion.make("launch-v1"),
    modelRoute: ManagedModelRoute.make("@cf/deepseek-ai/deepseek-v4-flash-0731"),
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: AuthSessionId.make("document-build-auth-session"),
    },
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    previewStoredAt: null,
    publicationCommittedAt: null,
    request: DocumentBuild.StoredRequest.make({
      fileSnapshots: [
        {
          byteLength: 12n,
          fileId: FileId.make("document-source"),
          mediaType: "text/plain",
          sha256: FileDigest.make(`sha256:${"c".repeat(64)}`),
        },
      ],
      format: "pdf",
      source: { pages: [{ lines: ["hello"], title: "Source" }] },
    }),
    resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
    routeId: ConversationRouteId.make("document-build-route"),
    safeFailureCode: null,
    sessionId: SessionId.make("document-build-session"),
    startedAt: null,
    state: "admitted",
    terminalAt: null,
    userId,
    workflowId,
  };
};
