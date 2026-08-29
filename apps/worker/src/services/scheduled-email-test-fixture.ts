/* oxlint-disable effecttsgo/global-date -- Fixed timestamps define deterministic Scheduled Email fixtures. */
import {
  AgentId,
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ConversationRouteId,
  ManifestVersion,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
  SessionId,
  UserId,
} from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import { ApprovalPresentation } from "./authorization";
import { ManagedModelRoute } from "../domain/model-access-policy";
import { ScheduledEmail } from "./scheduled-email";

export const makeRecord = (
  overrides: Partial<ScheduledEmail.Record> = {},
): ScheduledEmail.Record => ({
  acceptedAt: new Date("2026-08-28T12:00:00.000Z"),
  actionId: ActionId.make("scheduled-email-accounting-action"),
  admittedAt: new Date("2026-08-28T11:59:00.000Z"),
  agentId: AgentId.make("scheduled-email-agent"),
  allowancePeriodId: AllowancePeriodId.make("scheduled-email-period"),
  approvalPresentation: ApprovalPresentation.make('{"scheduledAt":"2026-08-28T12:05:00.000Z"}'),
  cancelRequestedAt: null,
  capabilityCatalogVersion: CapabilityCatalogVersion.make("capability-catalog-v1"),
  cloudflareInstanceId: ScheduledEmail.CloudflareInstanceId.make("scheduled-email-instance"),
  dueAt: new Date("2026-08-28T12:05:00.000Z"),
  inputDigest: ScheduledEmail.InputDigest.make("a".repeat(64)),
  manifestVersion: ManifestVersion.make("gmail-v1"),
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make("launch-v1"),
  modelRoute: ManagedModelRoute.make("@cf/deepseek-ai/deepseek-v4-flash-0731"),
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("scheduled-email-session-authority"),
  },
  plan: "adventurer",
  planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
  providerLogId: null,
  providerResourceId: null,
  request: ScheduledEmail.Request.make({
    body: "Body",
    gmailResource: "primary",
    recipients: ["recipient@example.test"],
    scheduledAt: new Date("2026-08-28T12:05:00.000Z"),
    subject: "Subject",
  }),
  resourcePriceVersion: ResourcePriceVersion.make("resource-prices-v1"),
  routeId: ConversationRouteId.make("scheduled-email-route"),
  safeFailureCode: null,
  sendOutcome: null,
  sendAccountingBasis: null,
  sendOutcomeAt: null,
  sendAccountedAt: null,
  sendReconciliationClaimedAt: null,
  sendReconciliationLeaseExpiresAt: null,
  sendReconciliationRecoveryUsed: false,
  sendClaimGeneration: 0,
  sendStartedAt: null,
  sessionId: SessionId.make("scheduled-email-session"),
  state: "accepted",
  terminalAt: null,
  workflowStartAccountedAt: null,
  userId: UserId.make("scheduled-email-user"),
  waitingAt: null,
  workflowId: ScheduledEmail.WorkflowId.make("scheduled-email-workflow"),
  ...overrides,
});
