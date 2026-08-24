import { Predicate, Result, Schema } from "effect";

import {
  AllowancePeriodId,
  type CapabilityCatalogVersion,
  ChannelLinkId,
  type ManifestVersion,
  Plan,
  PlanPolicyVersion,
  UserId,
} from "../domain";
import { type AllowanceKind, RecordedAllowanceUse } from "../domain/allowance";
import {
  AuthorizationOperation,
  type AuthorizationOperationInput,
  AuthorizationOperationName,
} from "../domain/authorization-operation";
import { currentCapabilityCatalog, type CapabilityCatalog } from "../domain/capability-catalog";
import { resolveManifest, type IntegrationManifestOperation } from "../domain/integration-manifest";
import {
  type Capability,
  isLaunchPolicy,
  type PlanPolicyCatalog,
  type PlanRules,
  policyFor,
} from "../domain/plan-policy";
import { CoreMemoryAuthorizationSnapshot } from "../domain/core-memory-authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Authorization and manifest outcomes use the standard Effect _tag discriminator. */
import { AuthSessionAuthorityFact, AuthSessionId } from "../domain/auth-session";
import { ChannelLinkAuthorityFact } from "../domain/channel-link";
import { DeletionAccessFact } from "../domain/deletion-case";
import { UserAccessFact } from "../domain/user-suspension";

const ActingAuthority = Schema.Union([
  AuthSessionAuthorityFact,
  ChannelLinkAuthorityFact,
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["scheduledTask", "workflow"]),
    userId: UserId,
  }),
]);

/** Stable authority identity that originated one protected operation. */
export const OriginatingAuthority = Schema.Union([
  Schema.TaggedStruct("AuthSession", { authSessionId: AuthSessionId }),
  Schema.TaggedStruct("ChannelLink", { channelLinkId: ChannelLinkId }),
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["scheduledTask", "workflow"]),
  }),
]);

/** Nonempty immutable User-visible presentation retained with one Approval. */
export const ApprovalPresentation = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("ApprovalPresentation"),
);

/** Branded presentation that cannot be constructed from an empty string. */
export type ApprovalPresentation = typeof ApprovalPresentation.Type;

/** Exact User, operation, and Action approved for one protected effect. */
export const Approval = Schema.Struct({
  actionId: Schema.String,
  operation: AuthorizationOperationName,
  operationIdentity: Schema.String.check(Schema.isMinLength(1)),
  presentation: ApprovalPresentation,
  userId: UserId,
});

/** Bind Approval to the complete operation facts and retained immutable presentation. */
export const approvalFor = (
  userId: UserId,
  operation: AuthorizationOperation,
  presentation: ApprovalPresentation,
) =>
  Approval.make({
    actionId: operation.actionId,
    operation: operation.kind,
    operationIdentity: approvalIdentity(operation, presentation),
    presentation,
    userId,
  });

/** Current allowance facts used to admit or deny one operation. */
export const Allowance = Schema.Union([
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

/** Current Integration Connection fact used by Authorization. */
export const IntegrationConnection = Schema.Union([
  Schema.TaggedStruct("Connected", { toolkit: Schema.String, userId: UserId }),
  Schema.TaggedStruct("Revoked", { toolkit: Schema.String, userId: UserId }),
]);

/** Retained single Gmail fact used only by launch-v1 Authorization. */
export const GmailConnection = Schema.NullOr(IntegrationConnection);

/** Current live resource facts used by Authorization. */
export const LiveResourceFacts = Schema.Struct({
  activeGmSummonsInSession: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  activeReminders: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  concurrentCostlyJobs: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  concurrentExhaustedConnectorReads: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  concurrentExhaustedConversations: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  concurrentIntegrationEffects: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  concurrentWorkflows: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  exhaustedConnectorReadsInRollingDay: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  gmSummonsInPeriod: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  retainedFileBytes: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
});

/** Current Subscription fact used for Plan Entitlement checks. */
export const AuthorizationSubscription = Schema.Struct({
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
});

/** Current facts evaluated by launch Authorization in deterministic gate order. */
export const AuthorizationContext = Schema.Struct({
  allowance: Allowance,
  approval: Schema.NullOr(Approval),
  authority: Schema.NullOr(ActingAuthority),
  deletionAccess: DeletionAccessFact,
  gmailConnection: GmailConnection,
  integrationConnections: Schema.Array(IntegrationConnection),
  liveFacts: LiveResourceFacts,
  now: Schema.Date,
  originatingAuthority: OriginatingAuthority,
  requestVendorUsdMicros: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  resourceOwnerUserId: Schema.NullOr(UserId),
  subscription: AuthorizationSubscription,
  user: UserAccessFact,
});

/** Current facts evaluated by launch Authorization in deterministic gate order. */
export type AuthorizationContext = typeof AuthorizationContext.Type;

/** Capture only facts used by memory.clear admission and protected-effect recheck. */
export const snapshotCoreMemoryAuthorization = (
  context: AuthorizationContext,
): CoreMemoryAuthorizationSnapshot =>
  CoreMemoryAuthorizationSnapshot.make({
    authority: context.authority,
    deletionAccess: context.deletionAccess,
    now: context.now,
    originatingAuthority: context.originatingAuthority,
    resourceOwnerUserId: context.resourceOwnerUserId,
    subscription: context.subscription,
    user: context.user,
  });

/** Restore a complete unmetered context for memory.clear policy evaluation. */
export const restoreCoreMemoryAuthorization = (
  snapshot: CoreMemoryAuthorizationSnapshot,
): AuthorizationContext =>
  AuthorizationContext.make({
    allowance: { _tag: "Unavailable" },
    approval: null,
    authority: restoreActingAuthority(snapshot.authority),
    deletionAccess: snapshot.deletionAccess,
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
    now: snapshot.now,
    originatingAuthority: restoreOriginatingAuthority(snapshot.originatingAuthority),
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: snapshot.resourceOwnerUserId,
    subscription: snapshot.subscription,
    user: snapshot.user,
  });

const restoreActingAuthority = (
  authority: CoreMemoryAuthorizationSnapshot["authority"],
): AuthorizationContext["authority"] => {
  if (authority === null) return null;
  if (Predicate.isTagged(authority, "AuthSession"))
    return { ...authority, authSessionId: AuthSessionId.make(authority.authSessionId) };
  if (Predicate.isTagged(authority, "RevokedAuthSession"))
    return { ...authority, authSessionId: AuthSessionId.make(authority.authSessionId) };
  if (Predicate.isTagged(authority, "ChannelLink"))
    return { ...authority, channelLinkId: ChannelLinkId.make(authority.channelLinkId) };
  if (Predicate.isTagged(authority, "RevokedChannelLink"))
    return { ...authority, channelLinkId: ChannelLinkId.make(authority.channelLinkId) };
  return authority;
};

const restoreOriginatingAuthority = (
  authority: CoreMemoryAuthorizationSnapshot["originatingAuthority"],
): AuthorizationContext["originatingAuthority"] => {
  if (Predicate.isTagged(authority, "AuthSession"))
    return { ...authority, authSessionId: AuthSessionId.make(authority.authSessionId) };
  if (Predicate.isTagged(authority, "ChannelLink"))
    return { ...authority, channelLinkId: ChannelLinkId.make(authority.channelLinkId) };
  return authority;
};

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
  readonly capabilityCatalogVersion: CapabilityCatalogVersion;
  readonly executionMode:
    | "exhaustedConnectorRead"
    | "exhaustedConversation"
    | "normalPlanUsage"
    | "unmeteredContinuity";
  readonly manifestVersion: ManifestVersion | null;
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
  readonly operation: AuthorizationOperationName;
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
export const make = (
  catalog: PlanPolicyCatalog,
  capabilityCatalog: CapabilityCatalog = currentCapabilityCatalog,
): Interface => {
  const admit = (
    context: AuthorizationContext,
    input: AuthorizationOperationInput,
  ): AuthorizationResult => {
    const decoded = Schema.decodeUnknownResult(AuthorizationOperation)(input);
    if (Result.isFailure(decoded)) {
      return { _tag: "Denied", reason: "unknownOperation", resetAt: null };
    }
    return authorize(catalog, capabilityCatalog, context, decoded.success, "admission");
  };

  return {
    admit,
    recheck: (context, operation) => {
      const decoded = Schema.decodeUnknownResult(AuthorizationOperation)(operation);
      if (Result.isFailure(decoded)) {
        return { _tag: "Denied", reason: "unknownOperation", resetAt: null };
      }
      const result = authorize(catalog, capabilityCatalog, context, decoded.success, "recheck");
      if (Predicate.isTagged(result, "Admitted")) return { _tag: "Permitted" };
      return Predicate.isTagged(result, "ApprovalRequired") ? denied("approvalRequired") : result;
    },
  };
};

const authorize = (
  catalog: PlanPolicyCatalog,
  capabilityCatalog: CapabilityCatalog,
  context: AuthorizationContext,
  operation: AuthorizationOperation,
  mode: "admission" | "recheck",
): AuthorizationResult => {
  const authority = context.authority;
  if (authority === null) return denied("authenticationRequired");
  if (
    Predicate.isTagged(authority, "RevokedAuthSession") ||
    Predicate.isTagged(authority, "RevokedChannelLink")
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

  if (!isLaunchPolicy(subscriptionPolicy)) {
    return authorizeShared(catalog, capabilityCatalog, context, operation, mode);
  }

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
      connection.userId !== context.user.userId ||
      connection.toolkit !== "gmail"
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
    return admitted(capabilityCatalog, "unmeteredContinuity");
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
  if (allowancePolicy === undefined || !isLaunchPolicy(allowancePolicy)) {
    return denied("policyUnavailable");
  }
  const allowanceRules = policyFor(allowancePolicy, allowance.plan);
  const relevantKinds = [...allowanceKindsFor(operation), "vendorUsdMicros" as const];
  for (const allowanceKind of relevantKinds) {
    if (allowanceKind === "planUsageMicros") continue;
    const recorded =
      allowance.usage.find((usage) => usage.allowanceKind === allowanceKind)?.quantity ?? 0n;
    if (recorded >= allowanceRules.allowanceLimits[allowanceKind]) {
      return denied("allowanceExhausted", allowance.endsAt);
    }
  }
  return {
    _tag: "Admitted",
    capabilityCatalogVersion: capabilityCatalog.version,
    executionMode: "normalPlanUsage",
    manifestVersion: null,
    allowancePeriod: {
      _tag: "Metered",
      allowancePeriodId: allowance.allowancePeriodId,
    },
  };
};

const authorizeShared = (
  catalog: PlanPolicyCatalog,
  capabilityCatalog: CapabilityCatalog,
  context: AuthorizationContext,
  operation: AuthorizationOperation,
  mode: "admission" | "recheck",
): AuthorizationResult => {
  if (!capabilityCatalog.operations.some((name) => name === operation.kind)) {
    return denied("unknownOperation");
  }
  const exception = capabilityCatalog.planExceptions.adventurer.some(
    (name) => name === operation.kind,
  );
  if (
    exception &&
    !capabilityCatalog.planExceptions[context.subscription.plan].some(
      (name) => name === operation.kind,
    )
  ) {
    return denied("missingEntitlement");
  }
  const integrationManifest = manifestForOperation(operation);
  if (Result.isFailure(integrationManifest)) return denied("unknownOperation");
  const manifest = integrationManifest.success;
  if (manifest !== null) {
    const connected = context.integrationConnections.some(
      (connection) =>
        Predicate.isTagged(connection, "Connected") &&
        connection.userId === context.user.userId &&
        connection.toolkit === manifest.toolkit,
    );
    if (!connected) {
      return denied("integrationConnectionRequired");
    }
  }
  const resourceLimits = capabilityCatalog.planResourceLimits[context.subscription.plan];
  if (exceedsGovernedLiveLimit(operation, context, resourceLimits)) {
    return denied("liveResourceLimitReached");
  }
  if (
    mode === "admission" &&
    exceedsGovernedOperationLimit(operation, capabilityCatalog, "normalPlanUsage")
  ) {
    return denied("operationLimitExceeded");
  }
  if (
    (requiresApproval(operation) || (manifest?.consequences.length ?? 0) > 0) &&
    !hasExactApproval(context, operation)
  ) {
    if (mode === "recheck") return denied("approvalRequired");
    return { _tag: "ApprovalRequired", actionId: operation.actionId, operation: operation.kind };
  }
  if (mode === "recheck" || isSharedUnmetered(operation)) {
    return admitted(capabilityCatalog, "unmeteredContinuity");
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
  if (allowancePolicy === undefined || isLaunchPolicy(allowancePolicy)) {
    return denied("policyUnavailable");
  }
  const pool = policyFor(allowancePolicy, allowance.plan).includedPlanUsageMicros;
  const recorded =
    allowance.usage.find((usage) => usage.allowanceKind === "planUsageMicros")?.quantity ?? 0n;
  if (recorded < pool) {
    return {
      _tag: "Admitted",
      allowancePeriod: { _tag: "Metered", allowancePeriodId: allowance.allowancePeriodId },
      capabilityCatalogVersion: capabilityCatalog.version,
      executionMode: "normalPlanUsage",
      manifestVersion: manifest?.manifestVersion ?? null,
    };
  }
  if (
    operation.kind === "conversation.run" &&
    context.liveFacts.concurrentExhaustedConversations <
      BigInt(capabilityCatalog.exhaustedConversation.concurrentOperations) &&
    !exceedsGovernedOperationLimit(operation, capabilityCatalog, "exhaustedConversation")
  ) {
    return admitted(capabilityCatalog, "exhaustedConversation");
  }
  if (
    operation.kind === "integration.read" &&
    manifest !== null &&
    manifest.exhaustedMode !== null &&
    context.liveFacts.concurrentExhaustedConnectorReads <
      BigInt(capabilityCatalog.exhaustedConnectorRead.concurrentReads) &&
    context.liveFacts.exhaustedConnectorReadsInRollingDay <
      BigInt(capabilityCatalog.exhaustedConnectorRead.callsPerRollingDay) &&
    withinExhaustedConnectorLimits(operation, capabilityCatalog, manifest)
  ) {
    return admitted(capabilityCatalog, "exhaustedConnectorRead", manifest.manifestVersion);
  }
  return denied("allowanceExhausted", allowance.endsAt);
};

const admitted = (
  capabilityCatalog: CapabilityCatalog,
  executionMode: Admitted["executionMode"],
  manifestVersion: ManifestVersion | null = null,
): Admitted => ({
  _tag: "Admitted",
  allowancePeriod: { _tag: "Unmetered" },
  capabilityCatalogVersion: capabilityCatalog.version,
  executionMode,
  manifestVersion,
});

const denied = (reason: AuthorizationDenialReason, resetAt: Date | null = null): Denied => ({
  _tag: "Denied",
  reason,
  resetAt,
});

const authorityPermits = (
  authority: Exclude<AuthorizationContext["authority"], null>,
  operation: AuthorizationOperation,
) => {
  if (!Predicate.isTagged(authority, "DurableTrigger")) return true;
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
  if (Predicate.isTagged(origin, "ChannelLink")) {
    return (
      (Predicate.isTagged(authority, "ChannelLink") ||
        Predicate.isTagged(authority, "RevokedChannelLink")) &&
      authority.channelLinkId === origin.channelLinkId
    );
  }
  return (
    Predicate.isTagged(authority, "DurableTrigger") &&
    authority.triggerId === origin.triggerId &&
    authority.triggerType === origin.triggerType
  );
};

const requiresOwnership = (operation: AuthorizationOperation) =>
  operation.kind.startsWith("session.") ||
  operation.kind.startsWith("memory.") ||
  operation.kind.startsWith("file.") ||
  operation.kind === "document.generate" ||
  operation.kind.startsWith("reminder.") ||
  operation.kind.startsWith("workflow.") ||
  operation.kind.startsWith("gmail.") ||
  operation.kind.startsWith("skill.") ||
  operation.kind.startsWith("integration.") ||
  operation.kind.startsWith("artifact.") ||
  operation.kind === "support.gmSummon";

const requiresGmailConnection = (operation: AuthorizationOperation) =>
  operation.kind.startsWith("gmail.") && operation.kind !== "gmail.connection.manage";

const exceedsLiveLimit = (
  operation: AuthorizationOperation,
  context: AuthorizationContext,
  rules: PlanRules,
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
  operation: AuthorizationOperation,
  context: AuthorizationContext,
  rules: PlanRules,
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

const exceedsGovernedLiveLimit = (
  operation: AuthorizationOperation,
  context: AuthorizationContext,
  limits: CapabilityCatalog["planResourceLimits"]["free"],
) => {
  if (
    !isSharedUnmetered(operation) &&
    context.liveFacts.concurrentCostlyJobs >= BigInt(limits.concurrentCostlyJobs)
  ) {
    return true;
  }
  switch (operation.kind) {
    case "file.upload":
      return (
        context.liveFacts.retainedFileBytes + operation.bytes > limits.retainedUserContentBytes
      );
    case "reminder.manage":
      return (
        (operation.change === "oneTimeCreate" || operation.change === "recurringCreate") &&
        context.liveFacts.activeReminders >= BigInt(limits.activeReminders)
      );
    case "workflow.manage":
      return (
        operation.change === "start" &&
        context.liveFacts.concurrentWorkflows >= BigInt(limits.activeWorkflows)
      );
    case "support.gmSummon":
      return (
        context.liveFacts.activeGmSummonsInSession >= BigInt(limits.activeGmSummonsPerSession) ||
        context.liveFacts.gmSummonsInPeriod >= BigInt(limits.gmSummonsPerPeriod)
      );
    case "integration.effect":
      return (
        context.liveFacts.concurrentIntegrationEffects >=
        BigInt(limits.concurrentIntegrationEffects)
      );
    default:
      return false;
  }
};

const exceedsGovernedOperationLimit = (
  operation: AuthorizationOperation,
  catalog: CapabilityCatalog,
  mode: "normalPlanUsage" | "exhaustedConversation",
) => {
  if (mode === "exhaustedConversation") {
    if (operation.kind !== "conversation.run") return true;
    const limits = catalog.exhaustedConversation;
    return (
      operation.inputTokens === undefined ||
      operation.documentChunks === undefined ||
      operation.outputTokens === undefined ||
      operation.queryRewrites === undefined ||
      operation.rerankingPasses === undefined ||
      operation.retries === undefined ||
      operation.skillLearningJobs === undefined ||
      operation.toolExecutions === undefined ||
      operation.memoryRecalls === undefined ||
      operation.memoryDeadlineMilliseconds === undefined ||
      operation.memoryProfileTokens === undefined ||
      operation.memoryQueryTokens === undefined ||
      operation.inputTokens > BigInt(limits.inputTokens) ||
      operation.outputTokens > BigInt(limits.outputTokens) ||
      operation.modelSteps > BigInt(limits.modelSteps) ||
      operation.retries > BigInt(limits.retries) ||
      operation.memoryRecalls > BigInt(limits.memoryRecalls) ||
      operation.memoryDeadlineMilliseconds > BigInt(limits.memoryDeadlineMilliseconds) ||
      operation.memoryProfileTokens > BigInt(limits.memoryProfileTokens) ||
      operation.memoryQueryTokens > BigInt(limits.memoryQueryTokens) ||
      operation.documentChunks > 0n ||
      operation.queryRewrites > 0n ||
      operation.rerankingPasses > 0n ||
      operation.skillLearningJobs > 0n ||
      operation.toolExecutions > 0n
    );
  }
  const limits = catalog.operationLimits;
  switch (operation.kind) {
    case "conversation.run":
      return operation.modelSteps > BigInt(limits.modelSteps);
    case "file.upload":
      return operation.bytes > limits.uploadBytes;
    case "artifact.generate":
    case "artifact.revise":
      if (operation.artifactKind === "pdf" || operation.artifactKind === "docx") {
        return (
          operation.bytes > limits.generatedDocumentBytes ||
          operation.pages > BigInt(limits.generatedDocumentPages)
        );
      }
      if (operation.artifactKind === "pptx") {
        return (
          operation.bytes > limits.generatedPresentationBytes ||
          operation.slides > BigInt(limits.generatedPresentationSlides)
        );
      }
      return (
        operation.bytes > limits.generatedImageBytes ||
        operation.pixelsPerEdge > BigInt(limits.generatedImagePixelsPerEdge)
      );
    case "integration.read":
      return (
        operation.providerExecutions >
          BigInt(catalog.integrationReadLimits.sequentialProviderCalls) ||
        operation.records >
          BigInt(
            catalog.integrationReadLimits.recordsPerCall *
              catalog.integrationReadLimits.sequentialProviderCalls,
          ) ||
        operation.responseBytes > catalog.integrationReadLimits.totalResponseBytes
      );
    default:
      return false;
  }
};

const manifestForOperation = (operation: AuthorizationOperation) => {
  if (operation.kind !== "integration.read" && operation.kind !== "integration.effect") {
    return Result.succeed<IntegrationManifestOperation | null>(null);
  }
  const resolved = resolveManifest(
    operation.toolkit,
    operation.providerOperation,
    operation.manifestVersion,
  );
  if (Result.isFailure(resolved)) return resolved;
  return resolved.success.operationKind ===
    (operation.kind === "integration.read" ? "read" : "effect")
    ? resolved
    : Result.fail(
        new Error("The manifest operation kind does not match the authorization operation"),
      );
};

const withinExhaustedConnectorLimits = (
  operation: Extract<AuthorizationOperation, { readonly kind: "integration.read" }>,
  catalog: CapabilityCatalog,
  manifest: IntegrationManifestOperation,
) => {
  const limits = catalog.exhaustedConnectorRead;
  if (
    operation.attachments > BigInt(limits.attachments) ||
    operation.deadlineMilliseconds > BigInt(limits.deadlineMilliseconds) ||
    operation.pagination > BigInt(limits.pagination) ||
    operation.providerExecutions > BigInt(limits.providerExecutions) ||
    operation.records > BigInt(limits.records) ||
    operation.responseBytes > limits.responseBytes
  ) {
    return false;
  }
  const declared = manifest.exhaustedMode;
  if (declared === null) return false;
  switch (declared._tag) {
    case "EmailThread":
      return (
        operation.records <= BigInt(declared.maximumMessages) &&
        operation.responseBytes <= BigInt(declared.responseBytes)
      );
    case "CalendarEvents":
      return (
        operation.windowDays !== undefined &&
        operation.records <= BigInt(declared.maximumEvents) &&
        operation.windowDays <= BigInt(declared.windowDays)
      );
    case "Availability":
      return (
        operation.windowDays !== undefined &&
        operation.records <= BigInt(declared.calendars) &&
        operation.windowDays <= BigInt(declared.windowDays)
      );
    case "ProviderMetadata":
      return (
        operation.records <= BigInt(declared.items) &&
        operation.responseBytes <= BigInt(declared.responseBytes)
      );
    default:
      return declared satisfies never;
  }
};

const requiresApproval = (operation: AuthorizationOperation) => {
  switch (operation.kind) {
    case "session.delete":
    case "memory.clear":
    case "memory.forgetKnowledge":
    case "file.delete":
    case "artifact.delete":
    case "gmail.send":
    case "support.gmSummon":
    case "account.delete":
      return true;
    case "skill.manage":
      return operation.change === "delete";
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

const isSharedUnmetered = (operation: AuthorizationOperation) => {
  switch (operation.kind) {
    case "conversation.accept":
    case "session.recall":
    case "session.delete":
    case "memory.inspect":
    case "memory.clear":
    case "memory.forgetKnowledge":
    case "file.read":
    case "file.delete":
    case "skill.inspect":
    case "skill.manage":
    case "artifact.read":
    case "artifact.delete":
    case "workflow.inspect":
    case "workflow.cancel":
    case "support.open":
    case "usage.inspect":
    case "billing.inspect":
    case "subscription.manage":
    case "authSession.revoke":
    case "channelLink.revoke":
    case "phoneAccount.replace":
    case "account.delete":
    case "dataRights.request":
      return true;
    case "reminder.manage":
      return operation.change === "cancel";
    case "workflow.manage":
      return operation.change === "stop";
    case "integration.connection.manage":
      return operation.change === "revoke";
    default:
      return false;
  }
};

const hasExactApproval = (context: AuthorizationContext, operation: AuthorizationOperation) =>
  context.approval !== null &&
  context.approval.userId === context.user.userId &&
  context.approval.operation === operation.kind &&
  context.approval.actionId === operation.actionId &&
  context.approval.operationIdentity === approvalIdentity(operation, context.approval.presentation);

const encodeAuthorizationOperation = Schema.encodeSync(AuthorizationOperation);

const operationIdentity = (operation: AuthorizationOperation): string =>
  JSON.stringify(encodeAuthorizationOperation(operation));

const approvalIdentity = (
  operation: AuthorizationOperation,
  presentation: ApprovalPresentation,
): string => JSON.stringify({ operation: operationIdentity(operation), presentation });

const isUnmetered = (operation: AuthorizationOperation) => {
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
    case "channelLink.revoke":
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

const allowanceKindsFor = (operation: AuthorizationOperation): ReadonlyArray<AllowanceKind> => {
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

const entitlementFor = (operation: AuthorizationOperation): Capability | null => {
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
    case "skill.inspect":
    case "skill.manage":
    case "artifact.generate":
    case "artifact.revise":
    case "artifact.read":
    case "artifact.delete":
    case "integration.connection.manage":
    case "integration.read":
    case "integration.effect":
      return null;
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
    case "channelLink.revoke":
    case "phoneAccount.replace":
    case "account.delete":
    case "dataRights.request":
      return null;
  }
  return null;
};

export * as Authorization from "./authorization";
