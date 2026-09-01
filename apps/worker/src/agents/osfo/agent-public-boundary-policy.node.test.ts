// oxlint-disable-next-line effecttsgo/node-builtin-import -- This Node-only structural audit reads the owning source file without entering Worker production composition.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

type BoundaryClass =
  | "cancellationReconciliationDeletion"
  | "deniedMutation"
  | "initialization"
  | "ordinaryMutation"
  | "read";
type Protection =
  | "accountDeletionFence"
  | "deletionOrchestration"
  | "directoryGate"
  | "fencedSessionExecution"
  | "initializationLifecycle"
  | "none"
  | "trackedThinkLifecycle";

const publicBoundaryPolicy = {
  analyzeFile: ["ordinaryMutation", "accountDeletionFence"],
  approveExecution: ["deniedMutation", "none"],
  authorizeAction: ["read", "trackedThinkLifecycle"],
  beforeStep: ["ordinaryMutation", "trackedThinkLifecycle"],
  beforeTurn: ["ordinaryMutation", "trackedThinkLifecycle"],
  beginScheduledEmail: ["ordinaryMutation", "accountDeletionFence"],
  boundCoreMemory: ["ordinaryMutation", "fencedSessionExecution"],
  cancelActionApproval: ["deniedMutation", "none"],
  cancelManagedConversation: ["cancellationReconciliationDeletion", "none"],
  changePersonalSkill: ["ordinaryMutation", "accountDeletionFence"],
  chatWithMessengerContext: ["ordinaryMutation", "fencedSessionExecution"],
  configureSession: ["initialization", "initializationLifecycle"],
  connectIntegrationFromSettings: ["ordinaryMutation", "accountDeletionFence"],
  correctCoreMemory: ["ordinaryMutation", "fencedSessionExecution"],
  decideActionApproval: ["ordinaryMutation", "accountDeletionFence"],
  deleteFile: ["ordinaryMutation", "accountDeletionFence"],
  deletePersonalSkillFromSettings: ["ordinaryMutation", "accountDeletionFence"],
  disconnectIntegrationFromSettings: ["ordinaryMutation", "accountDeletionFence"],
  executeScheduledEmail: ["ordinaryMutation", "accountDeletionFence"],
  deliverReminder: ["cancellationReconciliationDeletion", "accountDeletionFence"],
  exposeReminderWakeUpSources: ["cancellationReconciliationDeletion", "none"],
  getActions: ["read", "none"],
  getAIBinding: ["read", "none"],
  getModel: ["read", "none"],
  getSystemPrompt: ["read", "none"],
  getTools: ["read", "none"],
  initialize: ["initialization", "fencedSessionExecution"],
  inspect: ["read", "none"],
  inspectCoreMemory: ["read", "fencedSessionExecution"],
  inspectDocumentBuildSourceSnapshot: ["read", "accountDeletionFence"],
  inspectIntegrationConnections: ["read", "none"],
  inspectImmediateGmailSends: ["read", "none"],
  listActionPresentations: ["read", "none"],
  inspectUserFile: ["read", "accountDeletionFence"],
  inspectPersonalSkills: ["read", "none"],
  inspectReminderWakeUpSource: ["read", "none"],
  inspectReminderVerificationState: ["read", "none"],
  onChatError: ["ordinaryMutation", "trackedThinkLifecycle"],
  onChatResponse: ["ordinaryMutation", "trackedThinkLifecycle"],
  onStart: ["initialization", "initializationLifecycle"],
  onStepEnd: ["ordinaryMutation", "trackedThinkLifecycle"],
  onSubmissionStatus: ["ordinaryMutation", "trackedThinkLifecycle"],
  pendingApprovals: ["read", "none"],
  pendingReminderWakeUpSources: ["read", "none"],
  presentPersonalSkillDeletion: ["read", "none"],
  quiesceAccountDeletion: ["cancellationReconciliationDeletion", "none"],
  readActionPresentation: ["read", "none"],
  readFile: ["read", "none"],
  resolveDocumentBuildFiles: ["read", "accountDeletionFence"],
  readRoute: ["read", "none"],
  readSession: ["read", "none"],
  readSessionAuthorizationFacts: ["read", "none"],
  rejectExecution: ["deniedMutation", "none"],
  recoverScheduledEmail: ["cancellationReconciliationDeletion", "none"],
  reconcileMemoryProviderOutbox: ["cancellationReconciliationDeletion", "none"],
  reconcileImmediateGmailSend: ["cancellationReconciliationDeletion", "accountDeletionFence"],
  reconcileModelCallUsage: ["cancellationReconciliationDeletion", "none"],
  settleGatewayModelUsage: ["cancellationReconciliationDeletion", "none"],
  submitManagedConversation: ["ordinaryMutation", "fencedSessionExecution"],
  submitDocumentBuildFollowUp: ["ordinaryMutation", "fencedSessionExecution"],
  submitResearchReportFollowUp: ["ordinaryMutation", "fencedSessionExecution"],
  submitScheduledEmailFollowUp: ["ordinaryMutation", "fencedSessionExecution"],
  uploadFile: ["ordinaryMutation", "accountDeletionFence"],
  uploadUserTextFile: ["ordinaryMutation", "accountDeletionFence"],
} as const satisfies Record<string, readonly [BoundaryClass, Protection]>;

const directoryBoundaryPolicy = {
  chatWithMessengerContext: ["ordinaryMutation", "directoryGate"],
  beginScheduledEmail: ["ordinaryMutation", "directoryGate"],
  configureChannels: ["initialization", "initializationLifecycle"],
  changePersonalSkill: ["ordinaryMutation", "directoryGate"],
  decideActionApproval: ["ordinaryMutation", "directoryGate"],
  deleteAgent: ["cancellationReconciliationDeletion", "deletionOrchestration"],
  deletePersonalSkillFromSettings: ["ordinaryMutation", "directoryGate"],
  listActionPresentations: ["read", "directoryGate"],
  connectIntegrationFromSettings: ["ordinaryMutation", "directoryGate"],
  disconnectIntegrationFromSettings: ["ordinaryMutation", "directoryGate"],
  ensureAgent: ["initialization", "initializationLifecycle"],
  executeScheduledEmail: ["ordinaryMutation", "directoryGate"],
  exposeReminderWakeUpSources: ["ordinaryMutation", "directoryGate"],
  getModel: ["read", "none"],
  initializeAgent: ["initialization", "initializationLifecycle"],
  inspectAgent: ["read", "none"],
  inspectDocumentBuildSourceSnapshot: ["read", "directoryGate"],
  inspectIntegrationConnections: ["read", "directoryGate"],
  inspectImmediateGmailSends: ["read", "directoryGate"],
  inspectUserFile: ["read", "directoryGate"],
  inspectPersonalSkills: ["read", "directoryGate"],
  inspectReminderWakeUpSource: ["read", "directoryGate"],
  inspectReminderVerificationState: ["read", "directoryGate"],
  listAgents: ["read", "none"],
  onBeforeSubAgent: ["read", "none"],
  pendingReminderWakeUpSources: ["read", "directoryGate"],
  resolveDocumentBuildFiles: ["read", "directoryGate"],
  recoverScheduledEmail: ["cancellationReconciliationDeletion", "directoryGate"],
  presentPersonalSkillDeletion: ["read", "directoryGate"],
  submitDocumentBuildFollowUp: ["ordinaryMutation", "directoryGate"],
  submitResearchReportFollowUp: ["ordinaryMutation", "directoryGate"],
  submitScheduledEmailFollowUp: ["ordinaryMutation", "directoryGate"],
  uploadUserTextFile: ["ordinaryMutation", "directoryGate"],
  quiesceAgentAccountDeletion: ["cancellationReconciliationDeletion", "deletionOrchestration"],
} as const satisfies Record<string, readonly [BoundaryClass, Protection]>;

it("classifies every public Osfo Agent method under the account deletion boundary policy", () => {
  const source = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");
  const discovered = Array.from(
    source.matchAll(/^  (?:override )?(?:async )?([A-Za-z][A-Za-z0-9_]*)\(/gm),
    (match) => match[1] ?? "",
  );

  expect(new Set(discovered)).toEqual(new Set(Object.keys(publicBoundaryPolicy)));
  expect(discovered).toHaveLength(Object.keys(publicBoundaryPolicy).length);
  expect(
    Object.entries(publicBoundaryPolicy)
      .filter(([, [classification]]) => classification === "ordinaryMutation")
      .every(([, [, protection]]) => protection !== "none"),
  ).toBe(true);
  expect(publicBoundaryPolicy.inspectCoreMemory).toEqual(["read", "fencedSessionExecution"]);
});

it("classifies every public Osfo Directory method under the account deletion boundary policy", () => {
  const source = readFileSync(new URL("./directory.ts", import.meta.url), "utf8");
  const discovered = Array.from(
    source.matchAll(/^  (?:override )?(?:async )?([A-Za-z][A-Za-z0-9_]*)\(/gm),
    (match) => match[1] ?? "",
  );

  expect(new Set(discovered)).toEqual(new Set(Object.keys(directoryBoundaryPolicy)));
  expect(discovered).toHaveLength(Object.keys(directoryBoundaryPolicy).length);
  expect(directoryBoundaryPolicy.deleteAgent).toEqual([
    "cancellationReconciliationDeletion",
    "deletionOrchestration",
  ]);
  expect(directoryBoundaryPolicy.quiesceAgentAccountDeletion).toEqual([
    "cancellationReconciliationDeletion",
    "deletionOrchestration",
  ]);
});

it("denies native Think Approval decisions outside the authenticated Directory boundary", () => {
  const source = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");

  expect(source).toContain("approve: (executionId) => this.#approveThinkExecution(executionId)");
  expect(source).toContain(
    "reject: (executionId, reason) => this.#rejectThinkExecution(executionId, reason)",
  );
  expect(source).toMatch(
    /override async approveExecution\(executionId: string\): Promise<NativeApprovalDecisionDenied> \{\s+return nativeApprovalDecisionDenied\(executionId\);\s+\}/,
  );
  expect(source).toMatch(
    /override async rejectExecution\(executionId: string\): Promise<NativeApprovalDecisionDenied> \{\s+return nativeApprovalDecisionDenied\(executionId\);\s+\}/,
  );
  expect(source).toMatch(
    /async cancelActionApproval\([\s\S]*?return new ThinkApprovalUnavailable\([\s\S]*?authenticated Directory authority required[\s\S]*?\n  \}/,
  );
});
