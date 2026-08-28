import { Predicate } from "effect";

import type { AllowanceKind } from "../domain/allowance";
import type {
  AuthorizationOperation,
  AuthorizationOperationName,
} from "../domain/authorization-operation";
import type { Capability } from "../domain/plan-policy";
import { hasProtectedConsequence } from "../domain/capability-catalog";
import type { AuthorizationContext } from "./authorization";

const approvalOperations = new Set<AuthorizationOperationName>([
  "session.delete",
  "memory.clear",
  "memory.forgetKnowledge",
  "file.delete",
  "artifact.delete",
  "gmail.send",
  "support.gmSummon",
  "account.delete",
]);

const sharedUnmeteredOperations = new Set<AuthorizationOperationName>([
  "conversation.accept",
  "session.recall",
  "session.delete",
  "memory.inspect",
  "memory.clear",
  "memory.forgetKnowledge",
  "file.read",
  "file.delete",
  "skill.inspect",
  "skill.manage",
  "artifact.read",
  "artifact.delete",
  "workflow.inspect",
  "workflow.cancel",
  "support.open",
  "usage.inspect",
  "billing.inspect",
  "subscription.manage",
  "authSession.revoke",
  "channelLink.revoke",
  "phoneAccount.replace",
  "account.delete",
  "dataRights.request",
]);

const launchUnmeteredOperations = new Set<AuthorizationOperationName>([
  "session.delete",
  "memory.clear",
  "memory.forgetKnowledge",
  "file.delete",
  "workflow.cancel",
  "support.open",
  "usage.inspect",
  "billing.inspect",
  "subscription.manage",
  "authSession.revoke",
  "channelLink.revoke",
  "phoneAccount.replace",
  "account.delete",
  "dataRights.request",
]);

const allowanceKindsByOperation = new Map<AuthorizationOperationName, ReadonlyArray<AllowanceKind>>(
  [
    ["conversation.accept", ["acceptedMessages"]],
    ["conversation.run", ["supermemoryIngestionTokens", "supermemoryRetrievals"]],
    ["file.upload", ["fileUploads"]],
    ["gmail.read", ["gmailMessagesExamined"]],
    ["gmail.search", ["gmailSearches"]],
    ["gmail.send", ["gmailSends"]],
    ["reminder.deliver", ["reminderDeliveries"]],
    ["support.gmSummon", ["gmSummons"]],
  ],
);

const entitlementByOperation = new Map<AuthorizationOperationName, Capability>([
  ["conversation.accept", "conversation"],
  ["conversation.run", "conversation"],
  ["file.analyze", "files"],
  ["file.delete", "files"],
  ["file.read", "files"],
  ["file.upload", "files"],
  ["gmail.draft", "gmail"],
  ["gmail.read", "gmail"],
  ["gmail.search", "gmail"],
  ["gmail.send", "gmail"],
  ["memory.clear", "memory"],
  ["memory.correct", "memory"],
  ["memory.forgetKnowledge", "memory"],
  ["memory.inspect", "memory"],
  ["session.delete", "session"],
  ["session.recall", "session"],
  ["session.replace", "session"],
  ["support.gmSummon", "gmSummon"],
]);

export const requiresApproval = (operation: AuthorizationOperation) =>
  approvalOperations.has(operation.kind) ||
  (operation.kind === "workflow.manage" &&
    operation.change !== "stop" &&
    hasProtectedConsequence(operation.consequences ?? [])) ||
  (operation.kind === "skill.manage" && operation.change === "delete") ||
  (operation.kind === "reminder.manage" &&
    (operation.change === "oneTimeCreate" ||
      operation.change === "recurringCreate" ||
      operation.change === "oneTimeMaterialChange" ||
      operation.change === "recurringMaterialChange" ||
      operation.change === "oneTimeReactivate" ||
      operation.change === "recurringReactivate"));

export const isSharedUnmetered = (operation: AuthorizationOperation) =>
  sharedUnmeteredOperations.has(operation.kind) ||
  (operation.kind === "reminder.manage" && operation.change === "cancel") ||
  (operation.kind === "workflow.manage" && operation.change === "stop") ||
  (operation.kind === "integration.connection.manage" && operation.change === "revoke");

export const isLaunchUnmetered = (operation: AuthorizationOperation) =>
  launchUnmeteredOperations.has(operation.kind) ||
  (operation.kind === "reminder.manage" && operation.change === "cancel") ||
  (operation.kind === "workflow.manage" && operation.change === "stop") ||
  (operation.kind === "gmail.connection.manage" && operation.change === "revoke");

export const allowanceKindsFor = (
  operation: AuthorizationOperation,
): ReadonlyArray<AllowanceKind> => {
  if (operation.kind === "document.generate") {
    return [operation.artifactKind === "document" ? "generatedDocuments" : "researchReports"];
  }
  if (operation.kind === "workflow.manage") {
    return operation.change === "start" ? ["workflowStarts"] : [];
  }
  return allowanceKindsByOperation.get(operation.kind) ?? [];
};

export const entitlementFor = (operation: AuthorizationOperation): Capability | null => {
  if (operation.kind === "document.generate") {
    return operation.artifactKind === "document" ? "documents" : "researchReports";
  }
  if (operation.kind === "reminder.manage") {
    if (operation.change === "cancel") return null;
    return operation.change.startsWith("oneTime") ? "oneTimeReminders" : "recurringReminders";
  }
  if (operation.kind === "reminder.deliver") {
    return operation.schedule === "oneTime" ? "oneTimeReminders" : "recurringReminders";
  }
  if (operation.kind === "workflow.manage") {
    return operation.change === "stop" ? null : "workflows";
  }
  if (operation.kind === "gmail.connection.manage") {
    return operation.change === "revoke" ? null : "gmail";
  }
  return entitlementByOperation.get(operation.kind) ?? null;
};

export const requiresOwnership = (operation: AuthorizationOperation) =>
  operation.kind.startsWith("session.") ||
  operation.kind.startsWith("memory.") ||
  operation.kind.startsWith("file.") ||
  operation.kind === "document.generate" ||
  operation.kind.startsWith("reminder.") ||
  operation.kind.startsWith("workflow.") ||
  operation.kind.startsWith("gmail.") ||
  operation.kind.startsWith("skill.") ||
  operation.kind.startsWith("integration.") ||
  operation.kind.startsWith("web.") ||
  operation.kind.startsWith("artifact.") ||
  operation.kind === "support.gmSummon" ||
  operation.kind === "account.delete";

export const requiresGmailConnection = (operation: AuthorizationOperation) =>
  operation.kind.startsWith("gmail.") && operation.kind !== "gmail.connection.manage";

export const authorityPermits = (
  authority: Exclude<AuthorizationContext["authority"], null>,
  operation: AuthorizationOperation,
) => {
  if (!Predicate.isTagged(authority, "DurableTrigger")) return true;
  if (authority.triggerType === "deletionCase") return operation.kind === "account.delete";
  if (authority.triggerType === "scheduledTask") return operation.kind === "reminder.deliver";
  return (
    operation.kind.startsWith("workflow.") ||
    operation.kind.startsWith("gmail.") ||
    operation.kind.startsWith("integration.") ||
    operation.kind.startsWith("artifact.") ||
    operation.kind === "document.generate" ||
    operation.kind === "support.gmSummon"
  );
};
