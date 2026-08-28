/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed timestamps make persistence evidence deterministic. */
/* oxlint-disable effecttsgo/strict-effect-provide -- This test owns its isolated PostgreSQL database. */
/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Assertions execute inside Effect callbacks and inspect canonical Effect tags. */
/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise, effecttsgo/run-effect-inside-effect -- This test coordinates real concurrent Drizzle transactions around PostgreSQL advisory locks. */
/* oxlint-disable unicorn/consistent-function-scoping -- Each deferred resolver belongs to one isolated database race. */
import { expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { documentBuildNotifications, documentBuilds } from "@osfo/db/schema/document-builds";
import { researchReportNotifications, researchReports } from "@osfo/db/schema/research-reports";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
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
  ThinkSubmissionId,
  UserId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { AuthSessionId } from "../../domain/auth-session";
import { FileDigest } from "../../domain/file-content";
import { FileId } from "../../domain/file";
import { ManagedModelRoute } from "../../domain/model-access-policy";
import { DocumentBuild } from "../../services/document-build";
import { DocumentBuildFollowUp } from "../../services/document-build-follow-up";
import { ResearchReport } from "../../services/research-report";
import { DocumentBuildFollowUpPostgres } from "./document-build-follow-up";
import { DocumentBuildPostgres } from "./document-build";
import { ResearchReportPostgres } from "./research-report";
import { ResearchReportFollowUpPostgres } from "./research-report-follow-up";
import { lockWorkflowUser } from "./workflow-serialization";

const admittedAt = new Date("2099-08-28T12:00:00.000Z");
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
        ends_at: new Date("2099-09-28T12:00:00.000Z"),
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
    expect(
      yield* persistence
        .beginExecution(exact.workflowId, exact.inputDigest, admittedAt)
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "DocumentBuildConflict" } });

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
    const acceptedAt = new Date("2099-08-28T12:00:01.000Z");
    const startedAt = new Date("2099-08-28T12:00:02.000Z");
    const providerCostRecordedAt = new Date("2099-08-28T12:00:03.000Z");
    const previewStoredAt = new Date("2099-08-28T12:00:04.000Z");
    const accountingCommittedAt = new Date("2099-08-28T12:00:05.000Z");
    const publicationCommittedAt = new Date("2099-08-28T12:00:06.000Z");
    yield* persistence.markAccepted(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      acceptedAt,
    );
    yield* persistence.beginExecution(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      startedAt,
    );
    const winnerContentId = `document:workflow:${publicationWinner.workflowId}`;
    const winnerCost = {
      _tag: "Incurred" as const,
      allowancePeriodId,
      basis: "observed" as const,
      providerOperationId: "document-build-publication-winner",
      usdMicros: 25n,
    };
    const costRecorded = yield* persistence.recordProviderCost(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      winnerContentId,
      winnerCost,
      providerCostRecordedAt,
    );
    expect(costRecorded).toMatchObject({
      accountingCommittedAt: null,
      providerCostRecordedAt,
      state: "running",
    });
    yield* persistence.markPreviewStored(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      winnerContentId,
      previewStoredAt,
    );
    yield* persistence.markAccountingCommitted(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      winnerContentId,
      winnerCost,
      accountingCommittedAt,
    );
    const published = yield* persistence.commitPublication(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      winnerContentId,
      publicationCommittedAt,
    );
    const losingCancel = yield* persistence.requestCancel(
      publicationWinner.workflowId,
      publicationWinner.userId,
      admittedAt,
    );
    expect(published.state).toBe("publication_committed");
    expect(losingCancel.state).toBe("publication_committed");
    expect(
      yield* DocumentBuildFollowUpPostgres.make(fixture.database).claimPreview(
        payloadFor(publicationWinner),
        publicationCommittedAt,
      ),
    ).toEqual({ _tag: "Terminal" });
    expect(
      yield* persistence.enforceDeadline(
        publicationWinner.workflowId,
        publicationWinner.inputDigest,
        new Date("2099-08-28T14:00:00.000Z"),
      ),
    ).toMatchObject({ state: "publication_committed" });
    yield* Effect.promise(() =>
      fixture.database.insert(deletionCases).values({
        access_fenced_at: new Date("2099-08-28T12:00:07.000Z"),
        approval_action_id: "publication-winner-delete-action",
        approval_presentation: "Delete Account",
        deletion_case_id: "publication-winner-delete-case",
        reason: "User requested account deletion",
        requested_by_user_id: userId,
        user_id: userId,
      }),
    );
    expect(
      yield* DocumentBuildPostgres.quiesceForAccountDeletion(
        fixture.database,
        userId,
        new Date("2099-08-28T12:00:08.000Z"),
      ),
    ).toEqual({ _tag: "RecoveryPending", workflowIds: [publicationWinner.workflowId] });
    const succeeded = yield* persistence.finishSuccess(
      publicationWinner.workflowId,
      publicationWinner.inputDigest,
      winnerContentId,
      new Date("2099-08-28T12:00:09.000Z"),
    );
    expect(succeeded.state).toBe("success");
    expect(
      yield* DocumentBuildPostgres.quiesceForAccountDeletion(
        fixture.database,
        userId,
        new Date("2099-08-28T12:00:10.000Z"),
      ),
    ).toMatchObject({ _tag: "Ready" });
  }).pipe(Effect.scoped),
);

it.effect("serializes concurrent cross-type admission and deletion fencing", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const builds = DocumentBuildPostgres.make(fixture.database);
    const reports = ResearchReportPostgres.make(fixture.database);

    const admissions = yield* Effect.all(
      [
        builds.admit(record("9", "concurrent-build"), 1n).pipe(Effect.result),
        reports.admit(researchRecord("concurrent-report"), 1n).pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    expect(admissions.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
    expect(admissions.filter((outcome) => outcome._tag === "Failure")).toMatchObject([
      { failure: { _tag: "Denied", reason: "liveResourceLimitReached" } },
    ]);

    yield* Effect.promise(() => fixture.database.delete(researchReports));
    yield* Effect.promise(() => fixture.database.delete(documentBuilds));
    const freeBuildAdmissions = yield* Effect.all(
      [
        builds.admit(record("c", "free-concurrent-one"), 1n).pipe(Effect.result),
        builds.admit(record("d", "free-concurrent-two"), 1n).pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    expect(freeBuildAdmissions.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
    expect(freeBuildAdmissions.filter((outcome) => outcome._tag === "Failure")).toMatchObject([
      { failure: { _tag: "Denied", reason: "liveResourceLimitReached" } },
    ]);

    yield* Effect.promise(() => fixture.database.delete(documentBuilds));
    const overdue = {
      ...record("e", "overdue-host-recovery"),
      admittedAt: new Date("2098-08-28T12:00:00.000Z"),
      deadlineAt: new Date("2098-08-28T13:00:00.000Z"),
    };
    yield* builds.admit(overdue, 1n);
    expect(yield* DocumentBuildPostgres.hostRecoveryBatch(fixture.database, 1)).toEqual([
      {
        inputDigest: overdue.inputDigest,
        mainInstanceId: overdue.cloudflareInstanceId,
        timerInstanceId: overdue.cloudflareTimerInstanceId,
        workflowId: overdue.workflowId,
      },
    ]);

    yield* Effect.promise(() => fixture.database.delete(documentBuilds));
    const acquired = deferred();
    const release = deferred();
    const fence = fixture.database.transaction(async (transaction) => {
      await lockWorkflowUser(transaction, userId);
      acquired.resolve();
      await release.promise;
      await transaction.insert(deletionCases).values({
        access_fenced_at: admittedAt,
        approval_action_id: "document-build-race-delete-action",
        approval_presentation: "Delete Account",
        deletion_case_id: "document-build-race-delete-case",
        reason: "User requested account deletion",
        requested_by_user_id: userId,
        user_id: userId,
      });
    });
    yield* Effect.promise(() => acquired.promise);
    const lateAdmission = Effect.runPromise(
      builds.admit(record("a", "after-deletion-race"), 1n).pipe(Effect.result),
    );
    release.resolve();
    yield* Effect.promise(() => fence);
    expect(yield* Effect.promise(() => lateAdmission)).toMatchObject({
      failure: { _tag: "Denied", reason: "deletionAccessRevoked" },
    });
  }).pipe(Effect.scoped),
);

it.effect("rotates bounded host recovery and excludes newly deletion-fenced work", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const builds = DocumentBuildPostgres.make(fixture.database);
    const admitted = Array.from({ length: 25 }, (_, index) =>
      record("a", `host-rotation-${index.toString().padStart(2, "0")}`),
    );
    yield* Effect.forEach(admitted, (build) => builds.admit(build, 30n), {
      concurrency: 1,
      discard: true,
    });

    const first = yield* DocumentBuildPostgres.hostRecoveryBatch(fixture.database, 20);
    const second = yield* DocumentBuildPostgres.hostRecoveryBatch(fixture.database, 20);
    expect(first).toHaveLength(20);
    expect(second).toHaveLength(20);
    expect(new Set([...first, ...second].map(({ workflowId }) => workflowId)).size).toBe(25);

    const selected = second[0];
    if (selected === undefined) throw new Error("Expected a host recovery candidate");
    yield* Effect.promise(() =>
      fixture.database.insert(deletionCases).values({
        access_fenced_at: admittedAt,
        approval_action_id: "host-recovery-delete-action",
        approval_presentation: "Delete Account",
        deletion_case_id: "host-recovery-delete-case",
        reason: "User requested account deletion",
        requested_by_user_id: userId,
        user_id: userId,
      }),
    );
    expect(
      yield* DocumentBuildPostgres.hostRecoveryDisposition(
        fixture.database,
        selected.workflowId,
        selected.inputDigest,
      ),
    ).toBe("Terminate");
    expect(yield* DocumentBuildPostgres.hostRecoveryBatch(fixture.database, 20)).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "retains provider cost before validation and cancels publication at the fenced claim",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeTestDatabase;
      yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
      yield* applyMigrations(fixture.client);
      yield* seedUser(fixture.database);
      const persistence = DocumentBuildPostgres.make(fixture.database);
      const cost = {
        _tag: "Incurred" as const,
        allowancePeriodId,
        basis: "observed" as const,
        providerOperationId: "document-build-failed-provider-operation",
        usdMicros: 41n,
      };

      const failed = record("c", "failed-after-compute");
      yield* persistence.admit(failed, 10n);
      yield* persistence.markAccepted(failed.workflowId, failed.inputDigest, admittedAt);
      yield* persistence.beginExecution(failed.workflowId, failed.inputDigest, admittedAt);
      const failedContentId = `document:workflow:${failed.workflowId}`;
      const costCommitted = yield* persistence.recordProviderCost(
        failed.workflowId,
        failed.inputDigest,
        failedContentId,
        cost,
        admittedAt,
      );
      const costReplay = yield* persistence.recordProviderCost(
        failed.workflowId,
        failed.inputDigest,
        failedContentId,
        cost,
        admittedAt,
      );
      expect(costCommitted.costEvidence).toEqual(cost);
      expect(costReplay.costEvidence).toEqual(cost);
      const terminal = yield* persistence.finishTerminal(
        failed.workflowId,
        failed.inputDigest,
        "failure",
        "document-invalidArtifact",
        admittedAt,
      );
      expect(terminal).toMatchObject({ costEvidence: cost, state: "failure" });

      const deadline = {
        ...record("e", "publication-deadline"),
        deadlineAt: new Date("2099-08-28T12:30:00.000Z"),
      };
      yield* persistence.admit(deadline, 10n);
      yield* persistence.markAccepted(deadline.workflowId, deadline.inputDigest, admittedAt);
      yield* persistence.beginExecution(deadline.workflowId, deadline.inputDigest, admittedAt);
      const deadlineContentId = `document:workflow:${deadline.workflowId}`;
      const deadlineCost = {
        ...cost,
        providerOperationId: "document-build-deadline-provider-operation",
      };
      yield* persistence.recordProviderCost(
        deadline.workflowId,
        deadline.inputDigest,
        deadlineContentId,
        deadlineCost,
        admittedAt,
      );
      yield* persistence.markPreviewStored(
        deadline.workflowId,
        deadline.inputDigest,
        deadlineContentId,
        admittedAt,
      );
      yield* persistence.markAccountingCommitted(
        deadline.workflowId,
        deadline.inputDigest,
        deadlineContentId,
        deadlineCost,
        admittedAt,
      );
      expect(
        yield* persistence
          .commitPublication(
            deadline.workflowId,
            deadline.inputDigest,
            deadlineContentId,
            deadline.deadlineAt,
          )
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "DocumentBuildConflict" } });
      expect(yield* persistence.inspect(deadline.workflowId)).toMatchObject({
        publicationCommittedAt: null,
        safeFailureCode: "deadline-exceeded",
        state: "canceled",
      });

      const fenced = record("d", "publication-fenced");
      yield* persistence.admit(fenced, 10n);
      yield* persistence.markAccepted(fenced.workflowId, fenced.inputDigest, admittedAt);
      yield* persistence.beginExecution(fenced.workflowId, fenced.inputDigest, admittedAt);
      const fencedContentId = `document:workflow:${fenced.workflowId}`;
      const fencedCost = {
        ...cost,
        providerOperationId: "document-build-fenced-provider-operation",
      };
      yield* persistence.recordProviderCost(
        fenced.workflowId,
        fenced.inputDigest,
        fencedContentId,
        fencedCost,
        admittedAt,
      );
      yield* persistence.markPreviewStored(
        fenced.workflowId,
        fenced.inputDigest,
        fencedContentId,
        admittedAt,
      );
      yield* persistence.markAccountingCommitted(
        fenced.workflowId,
        fenced.inputDigest,
        fencedContentId,
        fencedCost,
        admittedAt,
      );
      yield* Effect.promise(() =>
        fixture.database.insert(deletionCases).values({
          access_fenced_at: admittedAt,
          approval_action_id: "document-build-publication-delete-action",
          approval_presentation: "Delete Account",
          deletion_case_id: "document-build-publication-delete-case",
          reason: "User requested account deletion",
          requested_by_user_id: userId,
          user_id: userId,
        }),
      );
      expect(
        yield* persistence
          .commitPublication(fenced.workflowId, fenced.inputDigest, fencedContentId, admittedAt)
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "DocumentBuildConflict" } });
      expect(yield* persistence.inspect(fenced.workflowId)).toMatchObject({
        publicationCommittedAt: null,
        safeFailureCode: "account-deletion",
        state: "canceled",
      });
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
    const previewAt = new Date("2099-08-28T12:16:00.000Z");
    const terminalAt = new Date("2099-08-28T12:17:00.000Z");
    const build = record("e", "follow-up");
    yield* persistence.admit(build, 10n);
    yield* persistence.markAccepted(build.workflowId, build.inputDigest, admittedAt);
    yield* persistence.beginExecution(build.workflowId, build.inputDigest, admittedAt);
    const contentId = `document:workflow:${build.workflowId}`;
    const followUpCost = {
      _tag: "Incurred" as const,
      allowancePeriodId,
      basis: "observed" as const,
      providerOperationId: "document-build-follow-up",
      usdMicros: 25n,
    };
    yield* persistence.recordProviderCost(
      build.workflowId,
      build.inputDigest,
      contentId,
      followUpCost,
      admittedAt,
    );
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
      followUpCost,
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
    const terminalNotificationId = DocumentBuildFollowUp.notificationIdFor(
      build.workflowId,
      "terminal",
    );
    const replacementSessionId = SessionId.make("document-build-replacement-session");
    const stableSelection = yield* followUps.selectDeliverySession(
      terminalNotificationId,
      replacementSessionId,
    );
    const replayedSelection = yield* followUps.selectDeliverySession(
      terminalNotificationId,
      SessionId.make("document-build-later-session"),
    );
    expect(stableSelection.deliverySessionId).toBe(replacementSessionId);
    expect(replayedSelection.deliverySessionId).toBe("document-build-later-session");
    yield* followUps.markAccepted(
      terminalNotificationId,
      ThinkSubmissionId.make("document-build-terminal-submission"),
      terminalAt,
    );
    expect(
      yield* followUps
        .markAccepted(
          terminalNotificationId,
          ThinkSubmissionId.make("document-build-conflicting-submission"),
          terminalAt,
        )
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: "DocumentBuildFollowUpConflict" } });
    expect((yield* followUps.inspect(terminalNotificationId))?.deliverySessionId).toBe(
      "document-build-later-session",
    );
    expect(
      (yield* followUps.selectDeliverySession(
        terminalNotificationId,
        SessionId.make("document-build-newest-session"),
      )).deliverySessionId,
    ).toBe("document-build-later-session");
    const delayedPreview = yield* followUps.inspect(
      DocumentBuildFollowUp.notificationIdFor(build.workflowId, "previewReady"),
    );
    expect(delayedPreview).not.toBeNull();
    if (delayedPreview !== null) {
      expect(DocumentBuildFollowUp.previewSubmissionDisposition(delayedPreview)).toBe(
        "PromoteTerminal",
      );
    }

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
    const previewAt = new Date("2099-08-28T12:16:00.000Z");
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
      deadline_at: new Date("2099-08-28T13:00:00.000Z"),
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

it.effect("serializes concurrent cross-type milestone claims at the global cap", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const builds = DocumentBuildPostgres.make(fixture.database);
    const reports = ResearchReportPostgres.make(fixture.database);
    const buildFollowUps = DocumentBuildFollowUpPostgres.make(fixture.database);
    const reportFollowUps = ResearchReportFollowUpPostgres.make(fixture.database);
    const dueAt = new Date("2099-08-28T12:16:00.000Z");

    const historical = [
      researchRecord("milestone-history-1"),
      researchRecord("milestone-history-2"),
    ];
    for (const report of historical) yield* reports.admit(report, 10n);
    yield* Effect.promise(() =>
      fixture.database.insert(researchReportNotifications).values(
        historical.map((report, index) => ({
          claimed_at: new Date(dueAt.getTime() - (index + 1) * 60_000),
          kind: "sourcesCollected" as const,
          notification_id: `historical-milestone-${index}`,
          user_id: userId,
          workflow_id: report.workflowId,
        })),
      ),
    );

    const build = record("f", "concurrent-milestone-build");
    yield* builds.admit(build, 10n);
    yield* builds.markAccepted(build.workflowId, build.inputDigest, admittedAt);
    yield* builds.beginExecution(build.workflowId, build.inputDigest, admittedAt);
    yield* builds.markPreviewStored(
      build.workflowId,
      build.inputDigest,
      `document:workflow:${build.workflowId}`,
      dueAt,
    );

    const report = researchRecord("concurrent-milestone-report");
    yield* reports.admit(report, 10n);
    yield* Effect.promise(() =>
      fixture.database
        .update(researchReports)
        .set({
          accepted_at: admittedAt,
          manifest_version: "research-manifest-v1",
          source_manifest_digest: "d".repeat(64),
          source_manifest_key: "users/document-build-user/research/concurrent/manifest.json",
          started_at: admittedAt,
          state: "sources_committed",
        })
        .where(eq(researchReports.workflow_id, report.workflowId)),
    );

    const outcomes = yield* Effect.all(
      [
        buildFollowUps.claimPreview(payloadFor(build), dueAt),
        reportFollowUps.claimMilestone(
          ResearchReport.WorkflowPayload.make({
            inputDigest: report.inputDigest,
            workflowId: report.workflowId,
          }),
          dueAt,
        ),
      ],
      { concurrency: "unbounded" },
    );
    expect(outcomes.filter((outcome) => outcome._tag === "Claimed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome._tag === "Suppressed")).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect("serializes a milestone claim behind deletion fencing without deadlock", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const builds = DocumentBuildPostgres.make(fixture.database);
    const followUps = DocumentBuildFollowUpPostgres.make(fixture.database);
    const dueAt = new Date("2099-08-28T12:16:00.000Z");
    const build = record("e", "milestone-deletion-race");
    yield* builds.admit(build, 10n);
    yield* builds.markAccepted(build.workflowId, build.inputDigest, admittedAt);
    yield* builds.beginExecution(build.workflowId, build.inputDigest, admittedAt);
    yield* builds.markPreviewStored(
      build.workflowId,
      build.inputDigest,
      `document:workflow:${build.workflowId}`,
      dueAt,
    );

    const acquired = deferred();
    const release = deferred();
    const fence = fixture.database.transaction(async (transaction) => {
      await lockWorkflowUser(transaction, userId);
      acquired.resolve();
      await release.promise;
      await transaction.insert(deletionCases).values({
        access_fenced_at: dueAt,
        approval_action_id: "milestone-race-delete-action",
        approval_presentation: "Delete Account",
        deletion_case_id: "milestone-race-delete-case",
        reason: "User requested account deletion",
        requested_by_user_id: userId,
        user_id: userId,
      });
    });
    yield* Effect.promise(() => acquired.promise);
    const claim = Effect.runPromise(followUps.claimPreview(payloadFor(build), dueAt));
    release.resolve();
    yield* Effect.promise(() => fence);
    expect(yield* Effect.promise(() => claim)).toEqual({ _tag: "Suppressed" });
  }).pipe(Effect.scoped),
);

it.effect("serializes follow-up delivery and acceptance behind deletion fencing", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedUser(fixture.database);
    const builds = DocumentBuildPostgres.make(fixture.database);
    const followUps = DocumentBuildFollowUpPostgres.make(fixture.database);
    const dueAt = new Date("2099-08-28T12:16:00.000Z");
    const build = record("f", "follow-up-deletion-race");
    yield* builds.admit(build, 10n);
    yield* builds.markAccepted(build.workflowId, build.inputDigest, admittedAt);
    yield* builds.beginExecution(build.workflowId, build.inputDigest, admittedAt);
    yield* builds.markPreviewStored(
      build.workflowId,
      build.inputDigest,
      `document:workflow:${build.workflowId}`,
      dueAt,
    );
    yield* followUps.claimPreview(payloadFor(build), dueAt);
    const notificationId = DocumentBuildFollowUp.notificationIdFor(
      build.workflowId,
      "previewReady",
    );

    const acquired = deferred();
    const release = deferred();
    const fence = fixture.database.transaction(async (transaction) => {
      await lockWorkflowUser(transaction, userId);
      acquired.resolve();
      await release.promise;
      await transaction.insert(deletionCases).values({
        access_fenced_at: dueAt,
        approval_action_id: "follow-up-race-delete-action",
        approval_presentation: "Delete Account",
        deletion_case_id: "follow-up-race-delete-case",
        reason: "User requested account deletion",
        requested_by_user_id: userId,
        user_id: userId,
      });
    });
    yield* Effect.promise(() => acquired.promise);
    const writes = Promise.all([
      Effect.runPromise(
        followUps
          .selectDeliverySession(notificationId, SessionId.make("replacement-session"))
          .pipe(Effect.result),
      ),
      Effect.runPromise(
        followUps
          .markAccepted(notificationId, ThinkSubmissionId.make("follow-up-submission"), dueAt)
          .pipe(Effect.result),
      ),
    ]);
    release.resolve();
    yield* Effect.promise(() => fence);
    expect(yield* Effect.promise(() => writes)).toMatchObject([
      { failure: { _tag: "DocumentBuildFollowUpUnavailable" } },
      { failure: { _tag: "DocumentBuildFollowUpUnavailable" } },
    ]);
    const [row] = yield* Effect.promise(() =>
      fixture.database
        .select({
          deliveredAt: documentBuildNotifications.delivered_at,
          deliverySessionId: documentBuildNotifications.delivery_session_id,
        })
        .from(documentBuildNotifications)
        .where(eq(documentBuildNotifications.notification_id, notificationId)),
    );
    expect(row).toEqual({ deliveredAt: null, deliverySessionId: null });
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
    const previewAt = new Date("2099-08-28T12:16:00.000Z");
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
    expect(instances).toEqual({
      _tag: "Ready",
      instances: [{ main: build.cloudflareInstanceId, timer: build.cloudflareTimerInstanceId }],
    });
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
        ends_at: new Date("2099-09-28T12:00:00.000Z"),
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

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = () => complete();
  });
  return { promise, resolve };
};

const researchRecord = (identity: string): ResearchReport.Record => {
  const workflowId = ResearchReport.WorkflowId.make(`research:${identity}`);
  return {
    acceptedAt: null,
    actionId: ActionId.make(`research-action-${identity}`),
    admittedAt,
    agentId: AgentId.make("document-build-agent"),
    allowancePeriodId,
    approval: null,
    artifactContentId: null,
    artifactStoredAt: null,
    publicationCommittedAt: null,
    cancelRequestedAt: null,
    capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
    cloudflareInstanceId: ResearchReport.CloudflareInstanceId.make(`research-${identity}`),
    deadlineAt: new Date("2099-08-28T13:00:00.000Z"),
    inputDigest: ResearchReport.InputDigest.make("b".repeat(64)),
    manifestVersion: null,
    modelAccessPolicyVersion: ModelAccessPolicyVersion.make("launch-v1"),
    modelRoute: ManagedModelRoute.make("@cf/deepseek-ai/deepseek-v4-flash-0731"),
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: AuthSessionId.make("document-build-auth-session"),
    },
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    request: ResearchReport.Request.make({
      consequences: [],
      format: "pdf",
      queries: [`query-${identity}`],
      topic: `topic-${identity}`,
    }),
    resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
    routeId: ConversationRouteId.make("document-build-route"),
    safeFailureCode: null,
    sessionId: SessionId.make("document-build-session"),
    sourceManifestDigest: null,
    sourceManifestKey: null,
    startedAt: null,
    state: "admitted",
    terminalAt: null,
    userId,
    workflowId,
  };
};

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
    deadlineAt: new Date("2099-08-28T13:00:00.000Z"),
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
    providerCostRecordedAt: null,
    state: "admitted",
    terminalAt: null,
    userId,
    workflowId,
  };
};
