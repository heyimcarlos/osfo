import { expect, it } from "vitest";

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
import { launchModelAccessPolicy } from "../../domain/model-access-policy";
import { ResearchReport } from "../../services/research-report";
import { ResearchReportFollowUp } from "../../services/research-report-follow-up";
import { companyContinuityCostFact, researchReportFollowUpMetadata } from "./agent";

/* oxlint-disable effecttsgo/global-date -- Fixed notification facts prove replay-stable metadata. */

const claimedAt = new Date("2026-08-28T12:15:00.000Z");
const notification = {
  acceptedAt: null,
  agentId: AgentId.make("agent-research"),
  allowancePeriodId: AllowancePeriodId.make("period-research"),
  artifactContentId: null,
  capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
  claimedAt,
  inputDigest: ResearchReport.InputDigest.make("a".repeat(64)),
  kind: ResearchReportFollowUp.NotificationKind.make("sourcesCollected"),
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make("managed-routing-v1"),
  modelRoute: launchModelAccessPolicy.plans.adventurer.route,
  notificationId: ResearchReportFollowUp.NotificationId.make("report-sources"),
  plan: "adventurer" as const,
  planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
  reportState: ResearchReport.State.make("sources_committed"),
  resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
  routeId: ConversationRouteId.make("route-research"),
  safeFailureCode: null,
  sessionId: SessionId.make("session-research"),
  sourceExposedAt: null,
  userId: UserId.make("user-research"),
  whatsAppChannelLinkId: null,
  workflowId: ResearchReport.WorkflowId.make("workflow-research"),
} satisfies ResearchReportFollowUp.Notification;

it("builds byte-stable company-continuity metadata from committed notification facts", () => {
  const submissionId = ThinkSubmissionId.make("research-report-follow-up");
  const first = researchReportFollowUpMetadata(notification, submissionId);
  const second = researchReportFollowUpMetadata(notification, submissionId);

  expect(first).toEqual(second);
  expect(first.conservativeVendorUsdMicros).toBe(750_000);
  expect(first.companyCostResourcePriceVersion).toBe(notification.resourcePriceVersion);
  expect(first.coreMemoryAuthorization).toMatchObject({ now: claimedAt.toISOString() });
});

it("retains observed and ambiguous company-cost classifications without User allowance facts", () => {
  expect(companyContinuityCostFact({ _tag: "Observed", vendorUsdMicros: 12_345n })).toEqual({
    basis: "observed",
    vendorUsdMicros: 12_345n,
  });
  expect(
    companyContinuityCostFact({ _tag: "Ambiguous", conservativeVendorUsdMicros: 750_000n }),
  ).toEqual({ basis: "conservative", vendorUsdMicros: 750_000n });
});
