import { Predicate, Result } from "effect";

import type { ManifestVersion } from "../domain";
import type { AuthorizationOperation } from "../domain/authorization-operation";
import {
  type CapabilityCatalog,
  hasProtectedConsequence,
  type PlanResourceLimits,
} from "../domain/capability-catalog";
import {
  type IntegrationManifestCatalog,
  type IntegrationManifestOperation,
  resolveManifest,
} from "../domain/integration-manifest";
import { isLaunchPolicy, type PlanPolicyCatalog, policyFor } from "../domain/plan-policy";
import type {
  Admitted,
  AuthorizationContext,
  AuthorizationDenialReason,
  AuthorizationResult,
  Denied,
} from "./authorization";
import { isSharedUnmetered } from "./authorization-operation-policy";

/* oxlint-disable eslint/no-underscore-dangle -- Authorization and manifest outcomes use the Effect _tag discriminator. */

/** Shared helpers supplied by the public Authorization module without creating a module cycle. */
export interface SharedAuthorizationSupport {
  readonly admitted: (
    capabilityCatalog: CapabilityCatalog,
    executionMode: Admitted["executionMode"],
    manifestVersion?: ManifestVersion | null,
  ) => Admitted;
  readonly denied: (reason: AuthorizationDenialReason, resetAt?: Date | null) => Denied;
  readonly hasExactApproval: (
    context: AuthorizationContext,
    operation: AuthorizationOperation,
  ) => boolean;
  readonly requiresApproval: (operation: AuthorizationOperation) => boolean;
}

/** Evaluate the inactive shared Plan Usage policy after common authority checks pass. */
export const authorizeShared = (
  catalog: PlanPolicyCatalog,
  capabilityCatalog: CapabilityCatalog,
  manifestCatalog: IntegrationManifestCatalog,
  context: AuthorizationContext,
  operation: AuthorizationOperation,
  mode: "admission" | "recheck",
  support: SharedAuthorizationSupport,
): AuthorizationResult => {
  if (!capabilityCatalog.operations.some((name) => name === operation.kind)) {
    return support.denied("unknownOperation");
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
    return support.denied("missingEntitlement");
  }
  const integrationManifest = manifestForOperation(operation, manifestCatalog);
  if (Result.isFailure(integrationManifest)) return support.denied("unknownOperation");
  const manifest = integrationManifest.success;
  if (manifest !== null) {
    const connected = context.integrationConnections.some(
      (connection) =>
        Predicate.isTagged(connection, "Connected") &&
        connection.userId === context.user.userId &&
        connection.toolkit === manifest.toolkit,
    );
    if (!connected) return support.denied("integrationConnectionRequired");
  }
  const resourceLimits = capabilityCatalog.planResourceLimits[context.subscription.plan];
  if (
    operation.kind.startsWith("artifact.") &&
    context.requestVendorUsdMicros > resourceLimits.artifact.vendorUsdMicrosPerRequest
  ) {
    return support.denied("operationLimitExceeded");
  }
  if (exceedsGovernedLiveLimit(operation, context, resourceLimits)) {
    return support.denied("liveResourceLimitReached");
  }
  if (
    mode === "admission" &&
    exceedsGovernedOperationLimit(operation, capabilityCatalog, resourceLimits, "normalPlanUsage")
  ) {
    return support.denied("operationLimitExceeded");
  }
  if (
    (support.requiresApproval(operation) ||
      hasProtectedConsequence(manifest?.consequences ?? [])) &&
    !support.hasExactApproval(context, operation)
  ) {
    if (mode === "recheck") return support.denied("approvalRequired");
    return { _tag: "ApprovalRequired", actionId: operation.actionId, operation: operation.kind };
  }
  if (mode === "recheck" || isSharedUnmetered(operation)) {
    return support.admitted(capabilityCatalog, "unmeteredContinuity");
  }
  if (!Predicate.isTagged(context.allowance, "Metered")) {
    return support.denied("allowancePeriodUnavailable");
  }
  const allowance = context.allowance;
  if (
    context.now.getTime() < allowance.startsAt.getTime() ||
    context.now.getTime() >= allowance.endsAt.getTime()
  ) {
    return support.denied("allowancePeriodUnavailable", allowance.endsAt);
  }
  const allowancePolicy = catalog.policies.find(
    (policy) => policy.version === allowance.planPolicyVersion,
  );
  if (allowancePolicy === undefined || isLaunchPolicy(allowancePolicy)) {
    return support.denied("policyUnavailable");
  }
  const pool = policyFor(allowancePolicy, allowance.plan).includedPlanUsageMicros;
  const recorded =
    allowance.usage.find((usage) => usage.allowanceKind === "planUsageMicros")?.quantity ?? 0n;
  if (recorded < pool) {
    return {
      _tag: "Admitted",
      allowancePeriod: {
        _tag: "Metered",
        allowancePeriodId: allowance.allowancePeriodId,
        grantSource: "includedPlanUsage",
      },
      capabilityCatalogVersion: capabilityCatalog.version,
      executionMode: "normalPlanUsage",
      manifestVersion: manifest?.manifestVersion ?? null,
    };
  }
  if (
    operation.kind === "conversation.run" &&
    context.liveFacts.concurrentExhaustedConversations <
      BigInt(capabilityCatalog.exhaustedConversation.concurrentOperations) &&
    !exceedsExhaustedConversationLimit(operation, capabilityCatalog)
  ) {
    return support.admitted(capabilityCatalog, "exhaustedConversation");
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
    return support.admitted(capabilityCatalog, "exhaustedConnectorRead", manifest.manifestVersion);
  }
  return support.denied("allowanceExhausted", allowance.endsAt);
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
  resourceLimits: PlanResourceLimits,
  mode: "normalPlanUsage" | "exhaustedConversation",
) => {
  if (mode === "exhaustedConversation") {
    return exceedsExhaustedConversationLimit(operation, catalog);
  }
  const limits = catalog.operationLimits;
  switch (operation.kind) {
    case "conversation.run":
      return operation.modelSteps > BigInt(limits.modelSteps);
    case "file.upload":
      return operation.bytes > limits.uploadBytes;
    case "artifact.generate":
    case "artifact.revise":
      if (
        operation.computeMilliseconds > BigInt(resourceLimits.artifact.computeMilliseconds) ||
        operation.modelSteps > BigInt(resourceLimits.artifact.modelSteps)
      ) {
        return true;
      }
      if (operation.artifactKind === "pdf" || operation.artifactKind === "docx") {
        return (
          operation.bytes > resourceLimits.artifact.generatedDocumentBytes ||
          operation.pages > BigInt(resourceLimits.artifact.generatedDocumentPages)
        );
      }
      if (operation.artifactKind === "pptx") {
        return (
          operation.bytes > resourceLimits.artifact.generatedPresentationBytes ||
          operation.slides > BigInt(resourceLimits.artifact.generatedPresentationSlides)
        );
      }
      return (
        operation.bytes > resourceLimits.artifact.generatedImageBytes ||
        operation.pixelsPerEdge > BigInt(resourceLimits.artifact.generatedImagePixelsPerEdge)
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
    case "web.search":
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
    case "web.read":
      return (
        operation.pages > BigInt(limits.webRetrievedPages) ||
        operation.responseBytes > limits.webNormalizedPageBytes ||
        operation.deadlineMilliseconds > BigInt(limits.interactiveOperationMilliseconds) ||
        operation.redirects > 3n ||
        operation.retries > 1n
      );
    default:
      return false;
  }
};

/** Check the company-funded conversation envelope used after ordinary allowance exhaustion. */
export const exceedsExhaustedConversationLimit = (
  operation: AuthorizationOperation,
  catalog: CapabilityCatalog,
) => {
  if (operation.kind !== "conversation.run") return true;
  const limits = catalog.exhaustedConversation;
  return (
    operation.inputTokens === undefined ||
    operation.documentChunks === undefined ||
    operation.outputTokens === undefined ||
    operation.queryRewrites === undefined ||
    operation.rerankingPasses === undefined ||
    operation.retries === undefined ||
    operation.skillInstructions === undefined ||
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
    operation.skillInstructions !== limits.skillInstructions ||
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
};

const manifestForOperation = (
  operation: AuthorizationOperation,
  manifestCatalog: IntegrationManifestCatalog,
) => {
  if (operation.kind !== "integration.read" && operation.kind !== "integration.effect") {
    return Result.succeed<IntegrationManifestOperation | null>(null);
  }
  const resolved = resolveManifest(
    {
      manifestVersion: operation.manifestVersion,
      operation: operation.providerOperation,
      toolkit: operation.toolkit,
    },
    manifestCatalog,
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
  const declared = manifest.exhaustedMode;
  if (declared === null) return false;
  // Connector-specific result maxima override the shared record default for that result shape.
  // Every other shared deadline, execution, payload, pagination, and attachment bound still applies.
  const maximumRecords =
    declared._tag === "EmailThread" ? declared.maximumMessages : limits.records;
  if (
    operation.attachments > BigInt(limits.attachments) ||
    operation.deadlineMilliseconds > BigInt(limits.deadlineMilliseconds) ||
    operation.pagination > BigInt(limits.pagination) ||
    operation.providerExecutions > BigInt(limits.providerExecutions) ||
    operation.records > BigInt(maximumRecords) ||
    operation.responseBytes > limits.responseBytes
  ) {
    return false;
  }
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
