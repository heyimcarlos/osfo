import { describe, expect, it } from "@effect/vitest";

import { AllowancePeriodId, ManifestVersion, PlanPolicyVersion, UserId } from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import { retainedCatalog } from "../domain/plan-policy";
import {
  Approval,
  approvalFor,
  ApprovalPresentation,
  make,
  type AuthorizationContext,
} from "./authorization";

/* oxlint-disable effecttsgo/global-date -- Fixed authority and period fixtures prove policy boundaries. */

const userId = UserId.make("governed-user");
const authSessionId = AuthSessionId.make("governed-session");
const now = new Date("2026-08-23T12:00:00.000Z");
const resetsAt = new Date("2026-09-22T12:00:00.000Z");

const context = (
  plan: "free" | "adventurer",
  recordedPlanUsageMicros = 0n,
): AuthorizationContext => ({
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("shared-period"),
    endsAt: resetsAt,
    plan,
    planPolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
    startsAt: new Date("2026-08-23T00:00:00.000Z"),
    usage:
      recordedPlanUsageMicros === 0n
        ? []
        : [{ allowanceKind: "planUsageMicros", quantity: recordedPlanUsageMicros }],
  },
  approval: null,
  authority: { _tag: "AuthSession", authSessionId, expiresAt: resetsAt, userId },
  deletionAccess: { _tag: "DeletionAccessAvailable" },
  gmailConnection: null,
  integrationConnections: [],
  liveFacts: {
    activeGmSummonsInSession: 0n,
    activeReminders: 0n,
    concurrentCostlyJobs: 0n,
    concurrentExhaustedConnectorReads: 0n,
    concurrentExhaustedConversations: 0n,
    concurrentIntegrationEffects: 0n,
    concurrentWorkflows: 0n,
    exhaustedConnectorReadsInRollingDay: 0n,
    gmSummonsInPeriod: 0n,
    retainedFileBytes: 0n,
  },
  now,
  originatingAuthority: { _tag: "AuthSession", authSessionId },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: userId,
  subscription: { plan, planPolicyVersion: PlanPolicyVersion.make("shared-usage-v1") },
  user: { _tag: "ActiveUser", userId },
});

describe("governed Authorization", () => {
  it("admits the same self-serve artifact operation for both Plans", () => {
    const authorization = make(retainedCatalog);
    const operation = {
      actionId: "artifact-action",
      artifactKind: "pdf",
      bytes: 5_000_000n,
      kind: "artifact.generate",
      pages: 20n,
      pixelsPerEdge: 0n,
      slides: 0n,
    } as const;

    expect(authorization.admit(context("free"), operation)).toMatchObject({
      _tag: "Admitted",
      executionMode: "normalPlanUsage",
    });
    expect(authorization.admit(context("adventurer"), operation)).toMatchObject({
      _tag: "Admitted",
      executionMode: "normalPlanUsage",
    });
  });

  it("keeps GM Summon as the sole Plan exception", () => {
    const authorization = make(retainedCatalog);
    const operation = { actionId: "summon-action", kind: "support.gmSummon" } as const;

    expect(authorization.admit(context("free"), operation)).toEqual({
      _tag: "Denied",
      reason: "missingEntitlement",
      resetAt: null,
    });
    expect(authorization.admit(context("adventurer"), operation)).toEqual({
      _tag: "ApprovalRequired",
      actionId: "summon-action",
      operation: "support.gmSummon",
    });
  });

  it("continues bounded conversation but pauses artifact generation after exhaustion", () => {
    const authorization = make(retainedCatalog);
    const exhausted = context("free", 2_000_000n);
    const conversation = {
      actionId: "conversation-action",
      documentChunks: 0n,
      inputTokens: 8_000n,
      kind: "conversation.run",
      memoryDeadlineMilliseconds: 750n,
      memoryProfileTokens: 200n,
      memoryQueryTokens: 300n,
      memoryRecalls: 1n,
      modelSteps: 2n,
      outputTokens: 1_024n,
      queryRewrites: 0n,
      rerankingPasses: 0n,
      retries: 0n,
      skillLearningJobs: 0n,
      toolExecutions: 0n,
    } as const;

    expect(authorization.admit(exhausted, conversation)).toMatchObject({
      _tag: "Admitted",
      allowancePeriod: { _tag: "Unmetered" },
      executionMode: "exhaustedConversation",
    });
    for (const exceedsOneLimit of [
      { ...conversation, documentChunks: 1n },
      { ...conversation, inputTokens: 8_001n },
      { ...conversation, memoryDeadlineMilliseconds: 751n },
      { ...conversation, memoryProfileTokens: 201n },
      { ...conversation, memoryQueryTokens: 301n },
      { ...conversation, memoryRecalls: 2n },
      { ...conversation, modelSteps: 3n },
      { ...conversation, outputTokens: 1_025n },
      { ...conversation, queryRewrites: 1n },
      { ...conversation, rerankingPasses: 1n },
      { ...conversation, retries: 1n },
      { ...conversation, skillLearningJobs: 1n },
      { ...conversation, toolExecutions: 1n },
    ]) {
      expect(authorization.admit(exhausted, exceedsOneLimit)).toMatchObject({
        _tag: "Denied",
        reason: "allowanceExhausted",
      });
    }
    expect(
      authorization.admit(exhausted, {
        actionId: "artifact-action",
        artifactKind: "pdf",
        bytes: 1n,
        kind: "artifact.generate",
        pages: 1n,
        pixelsPerEdge: 0n,
        slides: 0n,
      }),
    ).toEqual({ _tag: "Denied", reason: "allowanceExhausted", resetAt: resetsAt });

    expect(
      authorization.admit(
        {
          ...exhausted,
          liveFacts: { ...exhausted.liveFacts, concurrentExhaustedConversations: 1n },
        },
        { ...conversation, actionId: "concurrent-conversation" },
      ),
    ).toMatchObject({ _tag: "Denied", reason: "allowanceExhausted" });
  });

  it("admits only manifest-declared bounded connector reads after exhaustion", () => {
    const authorization = make(retainedCatalog);
    const exhausted = {
      ...context("free", 2_000_000n),
      gmailConnection: { _tag: "Connected" as const, toolkit: "gmail", userId },
      integrationConnections: [{ _tag: "Connected" as const, toolkit: "gmail", userId }],
    };
    const read = {
      actionId: "read-thread",
      attachments: 0n,
      deadlineMilliseconds: 10_000n,
      kind: "integration.read",
      manifestVersion: ManifestVersion.make("gmail-v1"),
      pagination: 0n,
      providerExecutions: 1n,
      providerOperation: "GMAIL_FETCH_THREAD",
      records: 10n,
      responseBytes: 65_536n,
      toolkit: "gmail",
    } as const;

    expect(authorization.admit(exhausted, read)).toMatchObject({
      _tag: "Admitted",
      executionMode: "exhaustedConnectorRead",
      manifestVersion: "gmail-v1",
    });
    const firstFailingBounds = [
      { ...read, attachments: 1n },
      { ...read, deadlineMilliseconds: 10_001n },
      { ...read, pagination: 1n },
      { ...read, providerExecutions: 2n },
      { ...read, records: 11n },
      { ...read, responseBytes: 65_537n },
    ];
    for (const exceedsOneLimit of firstFailingBounds) {
      expect(authorization.admit(exhausted, exceedsOneLimit)).toEqual({
        _tag: "Denied",
        reason: "allowanceExhausted",
        resetAt: resetsAt,
      });
    }
    for (const liveFacts of [
      { ...exhausted.liveFacts, concurrentExhaustedConnectorReads: 1n },
      { ...exhausted.liveFacts, exhaustedConnectorReadsInRollingDay: 20n },
    ]) {
      expect(authorization.admit({ ...exhausted, liveFacts }, read)).toMatchObject({
        _tag: "Denied",
        reason: "allowanceExhausted",
      });
    }
    expect(authorization.admit(exhausted, { ...read, providerOperation: "GMAIL_UNKNOWN" })).toEqual(
      { _tag: "Denied", reason: "unknownOperation", resetAt: null },
    );
  });

  it("derives integration Approval from the manifest consequence", () => {
    const authorization = make(retainedCatalog);
    const send = {
      actionId: "send-email",
      kind: "integration.effect",
      manifestVersion: ManifestVersion.make("gmail-v1"),
      providerOperation: "GMAIL_SEND_EMAIL",
      toolkit: "gmail",
    } as const;
    const connected = {
      ...context("free"),
      gmailConnection: { _tag: "Connected" as const, toolkit: "gmail", userId },
      integrationConnections: [{ _tag: "Connected" as const, toolkit: "gmail", userId }],
    };

    expect(authorization.admit(connected, send)).toEqual({
      _tag: "ApprovalRequired",
      actionId: "send-email",
      operation: "integration.effect",
    });
    const exactApproval = approvalFor(
      userId,
      send,
      ApprovalPresentation.make("Send the presented email to its exact recipients"),
    );
    expect(authorization.admit({ ...connected, approval: exactApproval }, send)).toMatchObject({
      _tag: "Admitted",
      manifestVersion: "gmail-v1",
    });
    expect(
      authorization.admit(
        {
          ...connected,
          approval: Approval.make({
            ...exactApproval,
            presentation: ApprovalPresentation.make("Send a different presentation"),
          }),
        },
        send,
      ),
    ).toMatchObject({ _tag: "ApprovalRequired" });

    expect(
      authorization.admit(
        {
          ...connected,
          gmailConnection: { _tag: "Connected", toolkit: "googlecalendar", userId },
          integrationConnections: [{ _tag: "Connected", toolkit: "googlecalendar", userId }],
          approval: approvalFor(
            userId,
            send,
            ApprovalPresentation.make("Send the presented email to its exact recipients"),
          ),
        },
        {
          ...send,
          manifestVersion: "calendar-v1",
          providerOperation: "CALENDAR_UPDATE_EVENT",
          toolkit: "googlecalendar",
        },
      ),
    ).toMatchObject({ _tag: "ApprovalRequired" });
  });

  it("requires a connection for the exact manifest toolkit", () => {
    const authorization = make(retainedCatalog);
    const calendarRead = {
      actionId: "calendar-read",
      attachments: 0n,
      deadlineMilliseconds: 10_000n,
      kind: "integration.read",
      manifestVersion: "calendar-v1",
      pagination: 0n,
      providerExecutions: 1n,
      providerOperation: "CALENDAR_LIST_EVENTS",
      records: 10n,
      responseBytes: 65_536n,
      toolkit: "googlecalendar",
    } as const;

    expect(
      authorization.admit(
        {
          ...context("free"),
          gmailConnection: { _tag: "Connected", toolkit: "gmail", userId },
          integrationConnections: [{ _tag: "Connected", toolkit: "gmail", userId }],
        },
        calendarRead,
      ),
    ).toMatchObject({ _tag: "Denied", reason: "integrationConnectionRequired" });
  });
});
