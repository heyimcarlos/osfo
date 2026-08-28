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
import { type PlanUsageGrantSource, RecordedAllowanceUse } from "../domain/allowance";
import {
  AuthorizationOperation,
  type AuthorizationOperationInput,
  AuthorizationOperationName,
} from "../domain/authorization-operation";
import { currentCapabilityCatalog, type CapabilityCatalog } from "../domain/capability-catalog";
import {
  currentManifestCatalog,
  type IntegrationManifestCatalog,
} from "../domain/integration-manifest";
import {
  isLaunchPolicy,
  type PlanPolicyCatalog,
  type PlanRules,
  policyFor,
} from "../domain/plan-policy";
import { CoreMemoryAuthorizationSnapshot } from "../domain/core-memory-authorization";
import {
  allowanceKindsFor,
  authorityPermits,
  entitlementFor,
  isLaunchUnmetered,
  requiresApproval,
  requiresGmailConnection,
  requiresOwnership,
} from "./authorization-operation-policy";
import { authorizeShared, exceedsExhaustedConversationLimit } from "./shared-authorization";

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
    triggerType: Schema.Literals(["deletionCase", "scheduledTask", "workflow"]),
    userId: UserId,
  }),
]);

/** Stable authority identity that originated one protected operation. */
export const OriginatingAuthority = Schema.Union([
  Schema.TaggedStruct("AuthSession", { authSessionId: AuthSessionId }),
  Schema.TaggedStruct("ChannelLink", { channelLinkId: ChannelLinkId }),
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["deletionCase", "scheduledTask", "workflow"]),
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

/** Canonical current fact set when an operation owns no live-resource counters. */
export const emptyLiveResourceFacts = LiveResourceFacts.make({
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
    liveFacts: emptyLiveResourceFacts,
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
    | {
        readonly _tag: "Metered";
        readonly allowancePeriodId: AllowancePeriodId;
        readonly grantSource: PlanUsageGrantSource | null;
      };
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
  manifestCatalog: IntegrationManifestCatalog = currentManifestCatalog,
): Interface => {
  const admit = (
    context: AuthorizationContext,
    input: AuthorizationOperationInput,
  ): AuthorizationResult => {
    const decoded = Schema.decodeUnknownResult(AuthorizationOperation)(input);
    if (Result.isFailure(decoded)) {
      return { _tag: "Denied", reason: "unknownOperation", resetAt: null };
    }
    return authorize(
      catalog,
      capabilityCatalog,
      manifestCatalog,
      context,
      decoded.success,
      "admission",
    );
  };

  return {
    admit,
    recheck: (context, operation) => {
      const decoded = Schema.decodeUnknownResult(AuthorizationOperation)(operation);
      if (Result.isFailure(decoded)) {
        return { _tag: "Denied", reason: "unknownOperation", resetAt: null };
      }
      const result = authorize(
        catalog,
        capabilityCatalog,
        manifestCatalog,
        context,
        decoded.success,
        "recheck",
      );
      if (Predicate.isTagged(result, "Admitted")) return { _tag: "Permitted" };
      return Predicate.isTagged(result, "ApprovalRequired") ? denied("approvalRequired") : result;
    },
  };
};

const authorize = (
  catalog: PlanPolicyCatalog,
  capabilityCatalog: CapabilityCatalog,
  manifestCatalog: IntegrationManifestCatalog,
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
  const continuesExactDeletionCase =
    operation.kind === "account.delete" &&
    Predicate.isTagged(authority, "DurableTrigger") &&
    authority.triggerType === "deletionCase";
  if (
    Predicate.isTagged(context.deletionAccess, "DeletionAccessRevoked") &&
    !continuesExactDeletionCase
  ) {
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
    return authorizeShared(catalog, capabilityCatalog, manifestCatalog, context, operation, mode, {
      admitted,
      denied,
      hasExactApproval,
      requiresApproval,
    });
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
  if (mode === "admission" && exceedsOperationLimit(operation, context, rules, capabilityCatalog)) {
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

  if (mode === "recheck" || isLaunchUnmetered(operation)) {
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
  const allowanceExhausted = relevantKinds.some((allowanceKind) => {
    if (allowanceKind === "planUsageMicros") return false;
    const recorded =
      allowance.usage.find((usage) => usage.allowanceKind === allowanceKind)?.quantity ?? 0n;
    return recorded >= allowanceRules.allowanceLimits[allowanceKind];
  });
  if (allowanceExhausted) {
    if (
      operation.kind === "conversation.run" &&
      operation.exhaustedContinuity === "deletionOrDataRights" &&
      context.liveFacts.concurrentExhaustedConversations <
        BigInt(capabilityCatalog.exhaustedConversation.concurrentOperations) &&
      !exceedsExhaustedConversationLimit(operation, capabilityCatalog)
    ) {
      return admitted(capabilityCatalog, "exhaustedConversation");
    }
    return denied("allowanceExhausted", allowance.endsAt);
  }
  return {
    _tag: "Admitted",
    capabilityCatalogVersion: capabilityCatalog.version,
    executionMode: "normalPlanUsage",
    manifestVersion: null,
    allowancePeriod: {
      _tag: "Metered",
      allowancePeriodId: allowance.allowancePeriodId,
      grantSource: null,
    },
  };
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
  capabilityCatalog: CapabilityCatalog,
) => {
  const artifactLimits = capabilityCatalog.planResourceLimits[context.subscription.plan].artifact;
  const artifactWrite =
    operation.kind === "artifact.generate" || operation.kind === "artifact.revise";
  const vendorLimit = artifactWrite
    ? artifactLimits.vendorUsdMicrosPerRequest
    : rules.operationLimits.vendorUsdMicrosPerRequest;
  if (context.requestVendorUsdMicros > vendorLimit) return true;
  switch (operation.kind) {
    case "conversation.run":
      return operation.modelSteps > rules.operationLimits.modelStepsPerRequest;
    case "file.upload":
      return operation.bytes > capabilityCatalog.operationLimits.uploadBytes;
    case "document.generate":
      return (
        operation.bytes > rules.operationLimits.documentBytes ||
        operation.pages > rules.operationLimits.documentPages ||
        (operation.artifactKind === "researchReport" &&
          operation.researchSearches > rules.operationLimits.researchSearches)
      );
    case "artifact.generate":
    case "artifact.revise": {
      if (
        operation.computeMilliseconds > BigInt(artifactLimits.computeMilliseconds) ||
        operation.modelSteps > BigInt(artifactLimits.modelSteps)
      ) {
        return true;
      }
      if (operation.artifactKind === "pdf" || operation.artifactKind === "docx") {
        return (
          operation.bytes > artifactLimits.generatedDocumentBytes ||
          operation.pages > BigInt(artifactLimits.generatedDocumentPages)
        );
      }
      if (operation.artifactKind === "pptx") {
        return (
          operation.bytes > artifactLimits.generatedPresentationBytes ||
          operation.slides > BigInt(artifactLimits.generatedPresentationSlides)
        );
      }
      return (
        operation.bytes > artifactLimits.generatedImageBytes ||
        operation.pixelsPerEdge > BigInt(artifactLimits.generatedImagePixelsPerEdge)
      );
    }
    case "web.search": {
      const limits = capabilityCatalog.operationLimits;
      return (
        operation.searches > BigInt(limits.webSearches) ||
        operation.results > BigInt(limits.webResultsPerSearch) ||
        operation.pages > BigInt(limits.webRetrievedPages) ||
        operation.responseBytes >
          limits.webNormalizedPageBytes * BigInt(limits.webRetrievedPages) ||
        operation.deadlineMilliseconds > BigInt(limits.interactiveOperationMilliseconds) ||
        operation.redirects > 3n ||
        operation.retries > 1n
      );
    }
    case "web.read": {
      const limits = capabilityCatalog.operationLimits;
      return (
        operation.pages > BigInt(limits.webRetrievedPages) ||
        operation.responseBytes > limits.webNormalizedPageBytes ||
        operation.deadlineMilliseconds > BigInt(limits.interactiveOperationMilliseconds) ||
        operation.redirects > 3n ||
        operation.retries > 1n
      );
    }
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

export * as Authorization from "./authorization";
