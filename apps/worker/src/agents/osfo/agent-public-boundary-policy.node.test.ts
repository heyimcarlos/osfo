// oxlint-disable-next-line effecttsgo/node-builtin-import -- This Node-only structural audit reads the owning source file without entering Worker production composition.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

type BoundaryClass =
  | "cancellationReconciliationDeletion"
  | "initialization"
  | "ordinaryMutation"
  | "read";
type Protection =
  | "accountDeletionFence"
  | "fencedSessionExecution"
  | "initializationLifecycle"
  | "none"
  | "trackedThinkLifecycle";

const publicBoundaryPolicy = {
  analyzeFile: ["ordinaryMutation", "accountDeletionFence"],
  authorizeAction: ["read", "trackedThinkLifecycle"],
  beforeStep: ["ordinaryMutation", "trackedThinkLifecycle"],
  beforeTurn: ["ordinaryMutation", "trackedThinkLifecycle"],
  boundCoreMemory: ["ordinaryMutation", "fencedSessionExecution"],
  cancelActionApproval: ["cancellationReconciliationDeletion", "none"],
  cancelManagedConversation: ["cancellationReconciliationDeletion", "none"],
  chatWithMessengerContext: ["ordinaryMutation", "fencedSessionExecution"],
  configureSession: ["initialization", "initializationLifecycle"],
  correctCoreMemory: ["ordinaryMutation", "fencedSessionExecution"],
  decideActionApproval: ["ordinaryMutation", "accountDeletionFence"],
  deleteFile: ["ordinaryMutation", "accountDeletionFence"],
  getActions: ["read", "none"],
  getModel: ["read", "none"],
  getSystemPrompt: ["read", "none"],
  getTools: ["read", "none"],
  initialize: ["initialization", "fencedSessionExecution"],
  inspect: ["read", "none"],
  inspectCoreMemory: ["read", "fencedSessionExecution"],
  onChatError: ["ordinaryMutation", "trackedThinkLifecycle"],
  onChatResponse: ["ordinaryMutation", "trackedThinkLifecycle"],
  onStart: ["initialization", "initializationLifecycle"],
  onStepEnd: ["ordinaryMutation", "trackedThinkLifecycle"],
  onSubmissionStatus: ["ordinaryMutation", "trackedThinkLifecycle"],
  pendingApprovals: ["read", "none"],
  probeRuntime: ["read", "none"],
  quiesceAccountDeletion: ["cancellationReconciliationDeletion", "none"],
  readActionPresentation: ["read", "none"],
  readCommittedTurns: ["cancellationReconciliationDeletion", "none"],
  readFile: ["read", "none"],
  readRoute: ["read", "none"],
  readSession: ["read", "none"],
  readSessionAuthorizationFacts: ["read", "none"],
  reconcileMemoryProviderOutbox: ["cancellationReconciliationDeletion", "none"],
  reconcileModelCallUsage: ["cancellationReconciliationDeletion", "none"],
  settleGatewayModelUsage: ["cancellationReconciliationDeletion", "none"],
  submitManagedConversation: ["ordinaryMutation", "fencedSessionExecution"],
  uploadFile: ["ordinaryMutation", "accountDeletionFence"],
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
