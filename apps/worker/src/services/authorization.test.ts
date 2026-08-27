import { describe, expect, it } from "@effect/vitest";
import { Predicate } from "effect";

import { AllowancePeriodId, ManifestVersion, PlanPolicyVersion, UserId } from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import { currentCapabilityCatalog } from "../domain/capability-catalog";
import type {
  AuthorizationOperation,
  AuthorizationOperationName,
} from "../domain/authorization-operation";
import { currentManifestCatalog, IntegrationManifestCatalog } from "../domain/integration-manifest";
import { retainedCatalog } from "../domain/plan-policy";
import {
  Approval,
  approvalFor,
  ApprovalPresentation,
  emptyLiveResourceFacts,
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
  liveFacts: emptyLiveResourceFacts,
  now,
  originatingAuthority: { _tag: "AuthSession", authSessionId },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: userId,
  subscription: { plan, planPolicyVersion: PlanPolicyVersion.make("shared-usage-v1") },
  user: { _tag: "ActiveUser", userId },
});

describe("governed Authorization", () => {
  it("permits only an exact Deletion Case trigger to continue fenced account deletion", () => {
    const authorization = make(retainedCatalog);
    const operation = { actionId: "account-delete-1", kind: "account.delete" } as const;
    const presentation = ApprovalPresentation.make("Delete this exact account");
    const fenced = {
      ...context("free"),
      allowance: { _tag: "Unavailable" as const },
      approval: approvalFor(userId, operation, presentation),
      authority: {
        _tag: "DurableTrigger" as const,
        triggerId: "deletion-case-1",
        triggerType: "deletionCase" as const,
        userId,
      },
      deletionAccess: { _tag: "DeletionAccessRevoked" as const },
      originatingAuthority: {
        _tag: "DurableTrigger" as const,
        triggerId: "deletion-case-1",
        triggerType: "deletionCase" as const,
      },
    };

    expect(authorization.recheck(fenced, operation)).toEqual({ _tag: "Permitted" });
    expect(
      authorization.recheck(
        { ...fenced, resourceOwnerUserId: UserId.make("another-user") },
        operation,
      ),
    ).toMatchObject({ _tag: "Denied", reason: "ownershipRequired" });
    expect(
      authorization.recheck({ ...fenced, user: { _tag: "SuspendedUser", userId } }, operation),
    ).toMatchObject({ _tag: "Denied", reason: "userSuspended" });
    expect(
      authorization.recheck(
        {
          ...fenced,
          approval: Approval.make({
            ...fenced.approval,
            presentation: ApprovalPresentation.make("Changed approval"),
          }),
        },
        operation,
      ),
    ).toMatchObject({ _tag: "Denied", reason: "approvalRequired" });
    expect(
      authorization.recheck(
        {
          ...fenced,
          subscription: {
            ...fenced.subscription,
            planPolicyVersion: PlanPolicyVersion.make("missing-policy"),
          },
        },
        operation,
      ),
    ).toMatchObject({ _tag: "Denied", reason: "policyUnavailable" });
    expect(
      authorization.recheck(
        {
          ...fenced,
          authority: { ...fenced.authority, triggerType: "scheduledTask" },
          originatingAuthority: {
            ...fenced.originatingAuthority,
            triggerType: "scheduledTask",
          },
        },
        operation,
      ),
    ).toMatchObject({ _tag: "Denied", reason: "authorityMismatch" });
  });

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

  it("admits every governed self-serve operation for both Plans", () => {
    const authorization = make(retainedCatalog);

    for (const plan of ["free", "adventurer"] as const) {
      for (const operationName of currentCapabilityCatalog.operations) {
        const operation = operationFor(operationName);
        const connected = {
          ...context(plan),
          gmailConnection: { _tag: "Connected" as const, toolkit: "gmail", userId },
          integrationConnections: [{ _tag: "Connected" as const, toolkit: "gmail", userId }],
        };
        const first = authorization.admit(connected, operation);
        const approvedContext = Predicate.isTagged(first, "ApprovalRequired")
          ? {
              ...connected,
              approval: approvalFor(
                userId,
                operation,
                ApprovalPresentation.make(`Approve ${operation.kind}`),
              ),
            }
          : connected;
        expect(authorization.admit(approvedContext, operation)).toMatchObject(
          plan === "free" && operationName === "support.gmSummon"
            ? { _tag: "Denied", reason: "missingEntitlement" }
            : { _tag: "Admitted" },
        );
      }
    }
  });

  it("requires exact Approval for every closed consequence class", () => {
    const baseManifest = currentManifestCatalog.manifests.find(
      ({ operation }) => operation === "GMAIL_SEND_EMAIL",
    );
    if (baseManifest === undefined) throw new Error("Gmail send manifest is missing");
    const manifests = IntegrationManifestCatalog.make({
      manifests: currentCapabilityCatalog.consequences.map((consequence) => ({
        ...baseManifest,
        consequences: [consequence],
        operation: `TEST_${consequence}`,
      })),
    });
    const authorization = make(retainedCatalog, currentCapabilityCatalog, manifests);
    const connected = {
      ...context("adventurer"),
      integrationConnections: [{ _tag: "Connected" as const, toolkit: "gmail", userId }],
    };

    for (const consequence of currentCapabilityCatalog.consequences) {
      const operation = {
        actionId: `action:${consequence}`,
        kind: "integration.effect",
        manifestVersion: ManifestVersion.make("gmail-v1"),
        providerOperation: `TEST_${consequence}`,
        toolkit: "gmail",
      } as const;
      expect(authorization.admit(connected, operation)).toMatchObject({
        _tag: "ApprovalRequired",
      });
      const approval = approvalFor(
        userId,
        operation,
        ApprovalPresentation.make(`Approve ${consequence}`),
      );
      expect(authorization.admit({ ...connected, approval }, operation)).toMatchObject({
        _tag: "Admitted",
      });
    }
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
      skillInstructions: "locallyAvailableOnly",
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
      { ...conversation, skillInstructions: "providerBacked" },
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
      records: 20n,
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
      { ...read, records: 21n },
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

  it("enforces every connector-specific exhausted-read bound independently", () => {
    const exhaustedFor = (toolkit: string) => ({
      ...context("free", 2_000_000n),
      integrationConnections: [{ _tag: "Connected" as const, toolkit, userId }],
    });
    const baseRead = {
      attachments: 0n,
      deadlineMilliseconds: 10_000n,
      kind: "integration.read" as const,
      pagination: 0n,
      providerExecutions: 1n,
    };
    const assertSpecificLimits = (
      authorization: ReturnType<typeof make>,
      exhausted: AuthorizationContext,
      admitted: Extract<AuthorizationOperation, { readonly kind: "integration.read" }>,
      firstFailures: ReadonlyArray<
        Extract<AuthorizationOperation, { readonly kind: "integration.read" }>
      >,
    ) => {
      expect(authorization.admit(exhausted, admitted)).toMatchObject({
        _tag: "Admitted",
        executionMode: "exhaustedConnectorRead",
      });
      for (const firstFailure of firstFailures) {
        expect(authorization.admit(exhausted, firstFailure)).toEqual({
          _tag: "Denied",
          reason: "allowanceExhausted",
          resetAt: resetsAt,
        });
      }
    };

    const calendar = {
      ...baseRead,
      actionId: "calendar-events",
      manifestVersion: ManifestVersion.make("calendar-v1"),
      providerOperation: "CALENDAR_LIST_EVENTS",
      records: 10n,
      responseBytes: 65_536n,
      toolkit: "googlecalendar",
      windowDays: 14n,
    };
    assertSpecificLimits(make(retainedCatalog), exhaustedFor("googlecalendar"), calendar, [
      { ...calendar, records: 11n },
      { ...calendar, windowDays: 15n },
    ]);

    const metadata = {
      ...baseRead,
      actionId: "drive-metadata",
      manifestVersion: ManifestVersion.make("drive-v1"),
      providerOperation: "DRIVE_GET_METADATA",
      records: 1n,
      responseBytes: 16_384n,
      toolkit: "googledrive",
    };
    assertSpecificLimits(make(retainedCatalog), exhaustedFor("googledrive"), metadata, [
      { ...metadata, records: 2n },
      { ...metadata, responseBytes: 16_385n },
    ]);

    const availabilityCatalog = IntegrationManifestCatalog.make({
      manifests: [
        ...currentManifestCatalog.manifests,
        {
          completedEvidence: "zeroMarginalCost",
          completedEvidenceContract: "boundedReadV1",
          consequences: [],
          exhaustedMode: { _tag: "Availability", calendars: 1, windowDays: 14 },
          hardBounds: {
            maximumRecords: 1,
            maximumResponseBytes: 65_536n,
            mutations: 0,
            providerExecutions: 1,
          },
          idempotency: "readOnly",
          inputContract: "calendarListEventsV1",
          manifestVersion: ManifestVersion.make("availability-v1"),
          operation: "CALENDAR_GET_AVAILABILITY",
          operationKind: "read",
          requiredConnection: true,
          safeErrors: [
            "connectionUnavailable",
            "inputRejected",
            "notFound",
            "providerRateLimited",
            "providerUnavailable",
            "resultInvalid",
          ],
          toolkit: "googlecalendar",
        },
      ],
    });
    const availability = {
      ...baseRead,
      actionId: "calendar-availability",
      manifestVersion: ManifestVersion.make("availability-v1"),
      providerOperation: "CALENDAR_GET_AVAILABILITY",
      records: 1n,
      responseBytes: 65_536n,
      toolkit: "googlecalendar",
      windowDays: 14n,
    };
    assertSpecificLimits(
      make(retainedCatalog, currentCapabilityCatalog, availabilityCatalog),
      exhaustedFor("googlecalendar"),
      availability,
      [
        { ...availability, records: 2n },
        { ...availability, windowDays: 15n },
      ],
    );
  });

  it("requires Approval for a one-time reminder but not for a Workflow start", () => {
    const authorization = make(retainedCatalog);

    expect(
      authorization.admit(context("free"), {
        actionId: "one-time-reminder",
        change: "oneTimeCreate",
        kind: "reminder.manage",
      }),
    ).toEqual({
      _tag: "ApprovalRequired",
      actionId: "one-time-reminder",
      operation: "reminder.manage",
    });
    expect(
      authorization.admit(context("free"), {
        actionId: "research-workflow",
        change: "start",
        kind: "workflow.manage",
      }),
    ).toMatchObject({ _tag: "Admitted", executionMode: "normalPlanUsage" });
  });

  it("selects included Plan Usage through the future grant-source seam", () => {
    const authorization = make(retainedCatalog);

    expect(
      authorization.admit(context("free"), {
        actionId: "artifact-action",
        artifactKind: "pdf",
        bytes: 1n,
        kind: "artifact.generate",
        pages: 1n,
        pixelsPerEdge: 0n,
        slides: 0n,
      }),
    ).toMatchObject({
      _tag: "Admitted",
      allowancePeriod: {
        _tag: "Metered",
        grantSource: "includedPlanUsage",
      },
    });
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
    expect(authorization.recheck({ ...connected, approval: exactApproval }, send)).toEqual({
      _tag: "Permitted",
    });
    expect(
      authorization.recheck(
        { ...connected, approval: exactApproval, integrationConnections: [] },
        send,
      ),
    ).toMatchObject({ _tag: "Denied", reason: "integrationConnectionRequired" });
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

const operationFor = (operation: AuthorizationOperationName): AuthorizationOperation => {
  switch (operation) {
    case "conversation.run":
      return { actionId: operation, kind: operation, modelSteps: 1n };
    case "file.upload":
      return { actionId: operation, bytes: 1n, kind: operation };
    case "artifact.generate":
    case "artifact.revise":
      return {
        actionId: operation,
        artifactKind: "pdf",
        bytes: 1n,
        kind: operation,
        pages: 1n,
        pixelsPerEdge: 0n,
        slides: 0n,
      };
    case "skill.manage":
      return { actionId: operation, change: "revise", kind: operation };
    case "skill.inspect":
    case "artifact.read":
    case "artifact.delete":
      return { actionId: operation, kind: operation };
    case "document.generate":
      return {
        actionId: operation,
        artifactKind: "document",
        bytes: 1n,
        kind: operation,
        pages: 1n,
        researchSearches: 0n,
      };
    case "reminder.manage":
      return { actionId: operation, change: "cancel", kind: operation };
    case "reminder.deliver":
      return { actionId: operation, kind: operation, schedule: "oneTime" };
    case "workflow.manage":
      return { actionId: operation, change: "start", kind: operation };
    case "integration.connection.manage":
      return { actionId: operation, change: "revoke", kind: operation, toolkit: "gmail" };
    case "gmail.connection.manage":
      return { actionId: operation, change: "revoke", kind: operation };
    case "integration.read":
      return {
        actionId: operation,
        attachments: 0n,
        deadlineMilliseconds: 1_000n,
        kind: operation,
        manifestVersion: ManifestVersion.make("gmail-v1"),
        pagination: 0n,
        providerExecutions: 1n,
        providerOperation: "GMAIL_FETCH_THREAD",
        records: 1n,
        responseBytes: 1n,
        toolkit: "gmail",
      };
    case "integration.effect":
      return {
        actionId: operation,
        kind: operation,
        manifestVersion: ManifestVersion.make("gmail-v1"),
        providerOperation: "GMAIL_CREATE_DRAFT",
        toolkit: "gmail",
      };
    default:
      return { actionId: operation, kind: operation };
  }
};
