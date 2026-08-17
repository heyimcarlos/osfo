import { Predicate, Result, Schema } from "effect";

import { AllowancePeriodId, Plan, PlanPolicyVersion, UserId } from "../domain";
import { type AllowanceKind, RecordedAllowanceUse } from "../domain/allowance";
import {
  AuthorizationOperation,
  type AuthorizationOperation as AuthorizationOperationType,
  type AuthorizationOperationInput,
  AuthorizationOperationName,
  type AuthorizationOperationName as AuthorizationOperationNameType,
} from "../domain/authorization-operation";
import { type Capability, type PlanPolicyCatalog, policyFor } from "../domain/plan-policy";

const ActiveUser = Schema.TaggedStruct("ActiveUser", { userId: UserId });
const SuspendedUser = Schema.TaggedStruct("SuspendedUser", { userId: UserId });
const DeletionAccess = Schema.Union([
  Schema.TaggedStruct("DeletionAccessAvailable", {}),
  Schema.TaggedStruct("DeletionAccessRevoked", {}),
]);
const ActingAuthority = Schema.Union([
  Schema.TaggedStruct("AuthSession", {
    authSessionId: Schema.String,
    expiresAt: Schema.Date,
    userId: UserId,
  }),
  Schema.TaggedStruct("RevokedAuthSession", {
    authSessionId: Schema.String,
    userId: UserId,
  }),
  Schema.TaggedStruct("ChannelBinding", {
    channelBindingId: Schema.String,
    userId: UserId,
  }),
  Schema.TaggedStruct("RevokedChannelBinding", {
    channelBindingId: Schema.String,
    userId: UserId,
  }),
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["scheduledTask", "workflow"]),
    userId: UserId,
  }),
]);
const OriginatingAuthority = Schema.Union([
  Schema.TaggedStruct("AuthSession", { authSessionId: Schema.String }),
  Schema.TaggedStruct("ChannelBinding", { channelBindingId: Schema.String }),
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["scheduledTask", "workflow"]),
  }),
]);
const Approval = Schema.Struct({
  actionId: Schema.String,
  operation: AuthorizationOperationName,
  userId: UserId,
});
const Allowance = Schema.Union([
  Schema.TaggedStruct("Unavailable", {}),
  Schema.TaggedStruct("Metered", {
    allowancePeriodId: AllowancePeriodId,
    endsAt: Schema.Date,
    plan: Plan,
    planPolicyVersion: PlanPolicyVersion,
    startsAt: Schema.Date,
    usage: Schema.Array(RecordedAllowanceUse),
  }),
]);

/** Current facts evaluated by launch Authorization in deterministic gate order. */
export const AuthorizationContext = Schema.Struct({
  allowance: Allowance,
  approval: Schema.NullOr(Approval),
  authority: Schema.NullOr(ActingAuthority),
  deletionAccess: DeletionAccess,
  gmailConnection: Schema.NullOr(
    Schema.Union([
      Schema.TaggedStruct("Connected", { userId: UserId }),
      Schema.TaggedStruct("Revoked", { userId: UserId }),
    ]),
  ),
  liveFacts: Schema.Struct({
    activeGmSummonsInSession: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
    activeReminders: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
    concurrentWorkflows: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
    retainedFileBytes: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  }),
  now: Schema.Date,
  originatingAuthority: OriginatingAuthority,
  requestVendorUsdMicros: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  resourceOwnerUserId: Schema.NullOr(UserId),
  subscription: Schema.Struct({ plan: Plan, planPolicyVersion: PlanPolicyVersion }),
  user: Schema.Union([ActiveUser, SuspendedUser]),
});

/** Current facts evaluated by launch Authorization in deterministic gate order. */
export type AuthorizationContext = typeof AuthorizationContext.Type;

/** Closed reasons returned by deterministic launch Authorization denial. */
export const AuthorizationDenialReason = Schema.Literals([
  "allowanceExhausted",
  "allowancePeriodUnavailable",
  "approvalRequired",
  "authenticationRequired",
  "authorityMismatch",
  "authorityRevoked",
  "deletionAccessRevoked",
  "integrationConnectionRequired",
  "liveResourceLimitReached",
  "missingEntitlement",
  "operationLimitExceeded",
  "ownershipRequired",
  "policyUnavailable",
  "unknownOperation",
  "userSuspended",
]);

/** Closed reasons returned by deterministic launch Authorization denial. */
export type AuthorizationDenialReason = typeof AuthorizationDenialReason.Type;

/** Successful Authorization outcome for work admitted below current limits. */
export type Admitted = {
  readonly _tag: "Admitted";
  readonly allowancePeriod:
    | { readonly _tag: "Unmetered" }
    | { readonly _tag: "Metered"; readonly allowancePeriodId: AllowancePeriodId };
};

/** Successful denial answer with an optional known reset time. */
export type Denied = {
  readonly _tag: "Denied";
  readonly reason: AuthorizationDenialReason;
  readonly resetAt: Date | null;
};

/** Successful answer that requires one exact Approval before admission. */
export type ApprovalRequired = {
  readonly _tag: "ApprovalRequired";
  readonly actionId: string;
  readonly operation: AuthorizationOperationNameType;
};

/** Deterministic default-deny Authorization answer. */
export type AuthorizationResult = Admitted | ApprovalRequired | Denied;

/** Protected-effect Authorization answer that never rechecks allowance. */
export type RecheckResult = { readonly _tag: "Permitted" } | Denied;

/** Launch Authorization public interface. */
export interface Interface {
  readonly admit: (
    context: AuthorizationContext,
    operation: AuthorizationOperationInput,
  ) => AuthorizationResult;
  readonly recheck: (
    context: AuthorizationContext,
    operation: AuthorizationOperationInput,
  ) => RecheckResult;
}

/** Construct deterministic launch Authorization from one retained policy version. */
export const make = (catalog: PlanPolicyCatalog): Interface => {
  const admit = (
    context: AuthorizationContext,
    input: AuthorizationOperationInput,
  ): AuthorizationResult => {
    const decoded = Schema.decodeUnknownResult(AuthorizationOperation)(input);
    if (Result.isFailure(decoded)) {
      return { _tag: "Denied", reason: "unknownOperation", resetAt: null };
    }
    return authorize(catalog, context, decoded.success, "admission");
  };

  return {
    admit,
    recheck: (context, operation) => {
      const decoded = Schema.decodeUnknownResult(AuthorizationOperation)(operation);
      if (Result.isFailure(decoded)) {
        return { _tag: "Denied", reason: "unknownOperation", resetAt: null };
      }
      const result = authorize(catalog, context, decoded.success, "recheck");
      if (Predicate.isTagged(result, "Admitted")) return { _tag: "Permitted" };
      return Predicate.isTagged(result, "ApprovalRequired") ? denied("approvalRequired") : result;
    },
  };
};

const authorize = (
  catalog: PlanPolicyCatalog,
  context: AuthorizationContext,
  operation: AuthorizationOperationType,
  mode: "admission" | "recheck",
): AuthorizationResult => {
  const authority = context.authority;
  if (authority === null) return denied("authenticationRequired");
  if (
    Predicate.isTagged(authority, "RevokedAuthSession") ||
    Predicate.isTagged(authority, "RevokedChannelBinding")
  ) {
    return denied("authorityRevoked");
  }
  if (
    Predicate.isTagged(authority, "AuthSession") &&
    authority.expiresAt.getTime() <= context.now.getTime()
  ) {
    return denied("authenticationRequired");
  }
  if (
    authority.userId !== context.user.userId ||
    !authorityMatchesOrigin(authority, context.originatingAuthority) ||
    !authorityPermits(authority, operation)
  ) {
    return denied("authorityMismatch");
  }
  if (Predicate.isTagged(context.user, "SuspendedUser")) return denied("userSuspended");
  if (Predicate.isTagged(context.deletionAccess, "DeletionAccessRevoked")) {
    return denied("deletionAccessRevoked");
  }
  if (requiresOwnership(operation) && context.resourceOwnerUserId !== context.user.userId) {
    return denied("ownershipRequired");
  }
  const subscriptionPolicy = catalog.policies.find(
    (policy) => policy.version === context.subscription.planPolicyVersion,
  );
  if (subscriptionPolicy === undefined) return denied("policyUnavailable");

  const rules = policyFor(subscriptionPolicy, context.subscription.plan);
  const requiredEntitlement = entitlementFor(operation);
  if (requiredEntitlement !== null && !rules.entitlements.includes(requiredEntitlement)) {
    return denied("missingEntitlement");
  }
  if (requiresGmailConnection(operation)) {
    const connection = context.gmailConnection;
    if (
      connection === null ||
      !Predicate.isTagged(connection, "Connected") ||
      connection.userId !== context.user.userId
    ) {
      return denied("integrationConnectionRequired");
    }
  }
  if (exceedsLiveLimit(operation, context, rules)) return denied("liveResourceLimitReached");
  if (mode === "admission" && exceedsOperationLimit(operation, context, rules)) {
    return denied("operationLimitExceeded");
  }
  if (requiresApproval(operation) && !hasExactApproval(context, operation)) {
    if (mode === "recheck") return denied("approvalRequired");
    return {
      _tag: "ApprovalRequired",
      actionId: operation.actionId,
      operation: operation.kind,
    };
  }

  if (mode === "recheck" || isUnmetered(operation)) {
    return { _tag: "Admitted", allowancePeriod: { _tag: "Unmetered" } };
  }
  if (!Predicate.isTagged(context.allowance, "Metered")) {
    return denied("allowancePeriodUnavailable");
  }
  const allowance = context.allowance;
  if (
    context.now.getTime() < allowance.startsAt.getTime() ||
    context.now.getTime() >= allowance.endsAt.getTime()
  ) {
    return denied("allowancePeriodUnavailable", allowance.endsAt);
  }
  const allowancePolicy = catalog.policies.find(
    (policy) => policy.version === allowance.planPolicyVersion,
  );
  if (allowancePolicy === undefined) return denied("policyUnavailable");
  const allowanceRules = policyFor(allowancePolicy, allowance.plan);
  const relevantKinds = [...allowanceKindsFor(operation), "vendorUsdMicros" as const];
  for (const allowanceKind of relevantKinds) {
    const recorded =
      allowance.usage.find((usage) => usage.allowanceKind === allowanceKind)?.quantity ?? 0n;
    if (recorded >= allowanceRules.allowanceLimits[allowanceKind]) {
      return denied("allowanceExhausted", allowance.endsAt);
    }
  }
  return {
    _tag: "Admitted",
    allowancePeriod: {
      _tag: "Metered",
      allowancePeriodId: allowance.allowancePeriodId,
    },
  };
};

const denied = (reason: AuthorizationDenialReason, resetAt: Date | null = null): Denied => ({
  _tag: "Denied",
  reason,
  resetAt,
});

const authorityPermits = (
  authority: Exclude<AuthorizationContext["authority"], null>,
  operation: AuthorizationOperationType,
) => {
  if (!Predicate.isTagged(authority, "DurableTrigger")) return true;
  if (authority.triggerType === "scheduledTask") return operation.kind === "reminder.deliver";
  return (
    operation.kind.startsWith("workflow.") ||
    operation.kind.startsWith("gmail.") ||
    operation.kind === "document.generate" ||
    operation.kind === "support.gmSummon"
  );
};

const authorityMatchesOrigin = (
  authority: Exclude<AuthorizationContext["authority"], null>,
  origin: AuthorizationContext["originatingAuthority"],
) => {
  if (Predicate.isTagged(origin, "AuthSession")) {
    return (
      (Predicate.isTagged(authority, "AuthSession") ||
        Predicate.isTagged(authority, "RevokedAuthSession")) &&
      authority.authSessionId === origin.authSessionId
    );
  }
  if (Predicate.isTagged(origin, "ChannelBinding")) {
    return (
      (Predicate.isTagged(authority, "ChannelBinding") ||
        Predicate.isTagged(authority, "RevokedChannelBinding")) &&
      authority.channelBindingId === origin.channelBindingId
    );
  }
  return (
    Predicate.isTagged(authority, "DurableTrigger") &&
    authority.triggerId === origin.triggerId &&
    authority.triggerType === origin.triggerType
  );
};

const requiresOwnership = (operation: AuthorizationOperationType) =>
  operation.kind.startsWith("session.") ||
  operation.kind.startsWith("memory.") ||
  operation.kind.startsWith("file.") ||
  operation.kind === "document.generate" ||
  operation.kind.startsWith("reminder.") ||
  operation.kind.startsWith("workflow.") ||
  operation.kind.startsWith("gmail.") ||
  operation.kind === "support.gmSummon";

const requiresGmailConnection = (operation: AuthorizationOperationType) =>
  operation.kind.startsWith("gmail.") && operation.kind !== "gmail.connection.manage";

const exceedsLiveLimit = (
  operation: AuthorizationOperationType,
  context: AuthorizationContext,
  rules: ReturnType<typeof policyFor>,
) => {
  switch (operation.kind) {
    case "file.upload":
      return (
        context.liveFacts.retainedFileBytes + operation.bytes > rules.liveLimits.retainedFileBytes
      );
    case "reminder.manage":
      return (
        (operation.change === "oneTimeCreate" || operation.change === "recurringCreate") &&
        context.liveFacts.activeReminders >= rules.liveLimits.activeReminders
      );
    case "workflow.manage":
      return (
        operation.change === "start" &&
        context.liveFacts.concurrentWorkflows >= rules.liveLimits.concurrentWorkflows
      );
    case "support.gmSummon":
      return (
        context.liveFacts.activeGmSummonsInSession >= rules.liveLimits.activeGmSummonsPerSession
      );
    default:
      return false;
  }
};

const exceedsOperationLimit = (
  operation: AuthorizationOperationType,
  context: AuthorizationContext,
  rules: ReturnType<typeof policyFor>,
) => {
  if (context.requestVendorUsdMicros > rules.operationLimits.vendorUsdMicrosPerRequest) return true;
  switch (operation.kind) {
    case "conversation.run":
      return operation.modelSteps > rules.operationLimits.modelStepsPerRequest;
    case "file.upload":
      return operation.bytes > rules.operationLimits.uploadBytes;
    case "document.generate":
      return (
        operation.bytes > rules.operationLimits.documentBytes ||
        operation.pages > rules.operationLimits.documentPages ||
        (operation.artifactKind === "researchReport" &&
          operation.researchSearches > rules.operationLimits.researchSearches)
      );
    default:
      return false;
  }
};

const requiresApproval = (operation: AuthorizationOperationType) => {
  switch (operation.kind) {
    case "session.replace":
    case "session.delete":
    case "memory.clear":
    case "memory.forgetKnowledge":
    case "file.delete":
    case "gmail.send":
    case "support.gmSummon":
    case "account.delete":
      return true;
    case "reminder.manage":
      return (
        operation.change === "recurringCreate" || operation.change === "recurringMaterialChange"
      );
    case "workflow.manage":
      return operation.change === "start" || operation.change === "materialChange";
    default:
      return false;
  }
};

const hasExactApproval = (context: AuthorizationContext, operation: AuthorizationOperationType) =>
  context.approval !== null &&
  context.approval.userId === context.user.userId &&
  context.approval.operation === operation.kind &&
  context.approval.actionId === operation.actionId;

const isUnmetered = (operation: AuthorizationOperationType) => {
  switch (operation.kind) {
    case "session.delete":
    case "memory.clear":
    case "memory.forgetKnowledge":
    case "file.delete":
    case "workflow.cancel":
    case "support.open":
    case "usage.inspect":
    case "billing.inspect":
    case "subscription.manage":
    case "authSession.revoke":
    case "channelBinding.revoke":
    case "phoneAccount.replace":
    case "account.delete":
    case "dataRights.request":
      return true;
    case "reminder.manage":
      return operation.change === "cancel";
    case "workflow.manage":
      return operation.change === "stop";
    case "gmail.connection.manage":
      return operation.change === "revoke";
    default:
      return false;
  }
};

const allowanceKindsFor = (operation: AuthorizationOperationType): ReadonlyArray<AllowanceKind> => {
  switch (operation.kind) {
    case "conversation.accept":
      return ["acceptedMessages"];
    case "conversation.run":
      return ["supermemoryIngestionTokens", "supermemoryRetrievals"];
    case "file.upload":
      return ["fileUploads"];
    case "document.generate":
      return [operation.artifactKind === "document" ? "generatedDocuments" : "researchReports"];
    case "reminder.deliver":
      return ["reminderDeliveries"];
    case "workflow.manage":
      return operation.change === "start" ? ["workflowStarts"] : [];
    case "gmail.search":
      return ["gmailSearches"];
    case "gmail.read":
      return ["gmailMessagesExamined"];
    case "gmail.send":
      return ["gmailSends"];
    case "support.gmSummon":
      return ["gmSummons"];
    default:
      return [];
  }
};

const entitlementFor = (operation: AuthorizationOperationType): Capability | null => {
  switch (operation.kind) {
    case "conversation.accept":
    case "conversation.run":
      return "conversation";
    case "session.recall":
    case "session.replace":
    case "session.delete":
      return "session";
    case "memory.inspect":
    case "memory.correct":
    case "memory.clear":
    case "memory.forgetKnowledge":
      return "memory";
    case "file.upload":
    case "file.read":
    case "file.analyze":
    case "file.delete":
      return "files";
    case "document.generate":
      return operation.artifactKind === "document" ? "documents" : "researchReports";
    case "reminder.manage":
      if (operation.change === "cancel") return null;
      return operation.change === "oneTimeCreate" ? "oneTimeReminders" : "recurringReminders";
    case "reminder.deliver":
      return operation.schedule === "oneTime" ? "oneTimeReminders" : "recurringReminders";
    case "workflow.manage":
      return operation.change === "stop" ? null : "workflows";
    case "workflow.inspect":
    case "workflow.cancel":
      return null;
    case "gmail.connection.manage":
      return operation.change === "revoke" ? null : "gmail";
    case "gmail.search":
    case "gmail.read":
    case "gmail.draft":
    case "gmail.send":
      return "gmail";
    case "support.gmSummon":
      return "gmSummon";
    case "support.open":
    case "usage.inspect":
    case "billing.inspect":
    case "subscription.manage":
    case "authSession.revoke":
    case "channelBinding.revoke":
    case "phoneAccount.replace":
    case "account.delete":
    case "dataRights.request":
      return null;
  }
  return null;
};
