import { Result, Schema } from "effect";

import { CapabilityCatalogVersion } from "../domain";

const capabilityIdValues = [
  "conversation",
  "core-memory",
  "memory-clear",
  "knowledge-forget",
  "session-delete",
  "session-recall",
  "file-read",
  "file-analysis",
  "document-generation",
  "document-read",
  "document-delete",
  "artifact-read",
  "artifact-delete",
  "web-search",
  "page-read",
  "research-report",
  "presentation-generation",
  "image-generation",
  "diagram-generation",
  "skill-management",
  "reminders",
  "workflows",
  "gmail",
  "google-calendar",
  "google-drive",
  "usage-management",
] as const;

/** Closed self-serve capability identity retained in catalogs and managed turns. */
export const CapabilityId = Schema.Literals(capabilityIdValues);

/** Closed self-serve capability identity retained in catalogs and managed turns. */
export type CapabilityId = typeof CapabilityId.Type;

/** Closed self-serve capability identities in deterministic catalog order. */
export const closedCapabilityIds: ReadonlyArray<CapabilityId> = capabilityIdValues;

/** Upper bound shared by retained inputs that may name every closed Capability. */
export const maximumCapabilityIds = capabilityIdValues.length;

/** Stable identity shared by every retained governed-capabilities-v1 snapshot. */
export const governedCapabilitiesV1Version = CapabilityCatalogVersion.make(
  "governed-capabilities-v1",
);

const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const nonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveBytes = Schema.BigInt.check(Schema.isGreaterThanBigInt(0n));

const governedOperationNames = [
  "conversation.accept",
  "conversation.run",
  "session.recall",
  "session.replace",
  "session.delete",
  "memory.inspect",
  "memory.correct",
  "memory.clear",
  "memory.forgetKnowledge",
  "file.upload",
  "file.read",
  "file.analyze",
  "file.delete",
  "skill.inspect",
  "skill.manage",
  "artifact.generate",
  "artifact.revise",
  "artifact.read",
  "artifact.delete",
  "integration.connection.manage",
  "integration.read",
  "integration.effect",
  "web.search",
  "web.read",
  "reminder.manage",
  "reminder.deliver",
  "workflow.manage",
  "workflow.inspect",
  "workflow.cancel",
  "support.open",
  "support.gmSummon",
  "usage.inspect",
  "billing.inspect",
  "subscription.manage",
  "authSession.revoke",
  "channelLink.revoke",
  "phoneAccount.replace",
  "account.delete",
  "dataRights.request",
] as const;

/** Generic and native operations available equally to both Plans. */
export const GovernedAuthorizationOperationName = Schema.Literals(governedOperationNames);

/** Generic and native operations available equally to both Plans. */
export type GovernedAuthorizationOperationName = typeof GovernedAuthorizationOperationName.Type;

/** Closed consequences that always require exact Approval. */
export const ConsequenceClass = Schema.Literals([
  "externalCommunication",
  "destructionOrOverwrite",
  "accessOrOwnershipChange",
  "financialCommitment",
  "futureOrRecurringExternalEffect",
  "humanEscalation",
]);

/** Closed consequences that always require exact Approval. */
export type ConsequenceClass = typeof ConsequenceClass.Type;

/** Any declared protected consequence requires exact Approval. */
export const hasProtectedConsequence = (consequences: ReadonlyArray<ConsequenceClass>): boolean =>
  consequences.length > 0;

/** Closed artifact kinds governed by the generic artifact operations. */
export const ArtifactKind = Schema.Literals(["pdf", "docx", "pptx", "image", "diagram"]);

/** Closed artifact kinds governed by the generic artifact operations. */
export type ArtifactKind = typeof ArtifactKind.Type;

const skillChanges = ["create", "revise", "rollback", "archive", "restore", "delete"] as const;

/** Closed User-triggered Skill lifecycle changes. */
export const SkillChange = Schema.Literals(skillChanges);

/** Closed User-triggered Skill lifecycle changes. */
export type SkillChange = typeof SkillChange.Type;

/** Equal hard limits for one bounded operation. */
export const GovernedOperationLimits = Schema.Struct({
  computeInputBytes: positiveBytes,
  computeMilliseconds: positiveInteger,
  csvInputRows: positiveInteger,
  durableArtifactOperationMilliseconds: positiveInteger,
  equivalentFallbackCandidatesPerModelStep: positiveInteger,
  filesPerUpload: positiveInteger,
  generatedDocumentBytes: positiveBytes,
  generatedDocumentPages: positiveInteger,
  generatedImageBytes: positiveBytes,
  generatedImagePixelsPerEdge: positiveInteger,
  generatedPresentationBytes: positiveBytes,
  generatedPresentationSlides: positiveInteger,
  imageInputPixels: positiveInteger,
  interactiveOperationMilliseconds: positiveInteger,
  modelSteps: positiveInteger,
  normalizedTextBytes: positiveBytes,
  officeArchiveEntries: positiveInteger,
  pdfInputPages: positiveInteger,
  recurringReminderMinimumIntervalMilliseconds: positiveInteger,
  researchArtifactCount: positiveInteger,
  researchOperationMilliseconds: positiveInteger,
  researchRetrievedPages: positiveInteger,
  researchSearches: positiveInteger,
  sameModelRetries: Schema.Literal(0),
  uploadBytes: positiveBytes,
  verifiedComputeOutputBytes: positiveBytes,
  webNormalizedPageBytes: positiveBytes,
  webPageBytes: positiveBytes,
  webResultsPerSearch: positiveInteger,
  webRetrievedPages: positiveInteger,
  webSearches: positiveInteger,
});

/** Equal hard limits for one ordinary integration read. */
export const IntegrationReadLimits = Schema.Struct({
  recordsPerCall: positiveInteger,
  responseBytesPerCall: positiveBytes,
  sequentialProviderCalls: positiveInteger,
  totalResponseBytes: positiveBytes,
});

/** Plan-specific live resource and concurrency ceilings. */
export const PlanResourceLimits = Schema.Struct({
  activeGmSummonsPerSession: nonNegativeInteger,
  activeReminders: positiveInteger,
  activeWorkflows: positiveInteger,
  concurrentCostlyJobs: positiveInteger,
  concurrentIntegrationEffects: positiveInteger,
  connectedAccountsPerToolkit: positiveInteger,
  gmSummonsPerPeriod: nonNegativeInteger,
  managedModelInputTokens: positiveInteger,
  managedModelOutputTokens: positiveInteger,
  retainedUserContentBytes: positiveBytes,
});

/** Company-funded limits for basic conversation after Plan Usage exhaustion. */
export const ExhaustedConversationLimits = Schema.Struct({
  concurrentOperations: positiveInteger,
  inputTokens: positiveInteger,
  memoryDeadlineMilliseconds: positiveInteger,
  memoryProfileTokens: positiveInteger,
  memoryQueryTokens: positiveInteger,
  memoryRecalls: positiveInteger,
  modelSteps: positiveInteger,
  outputTokens: positiveInteger,
  retries: Schema.Literal(0),
  skillInstructions: Schema.Literal("locallyAvailableOnly"),
});

/** Shared envelope for manifest-declared reads after Plan Usage exhaustion. */
export const ExhaustedConnectorReadLimits = Schema.Struct({
  attachments: Schema.Literal(0),
  callsPerRollingDay: positiveInteger,
  concurrentReads: positiveInteger,
  deadlineMilliseconds: positiveInteger,
  pagination: Schema.Literal(0),
  providerExecutions: positiveInteger,
  records: positiveInteger,
  responseBytes: positiveBytes,
});

/** Company-funded Skill Learning bounds shared by both Plans. */
export const SkillLearningLimits = Schema.Struct({
  candidateBytes: positiveBytes,
  candidateLifetimeMilliseconds: positiveInteger,
  candidatesPerUser: positiveInteger,
  concurrentJobsGlobally: positiveInteger,
  concurrentJobsPerUser: positiveInteger,
  jobsPerRollingDay: positiveInteger,
  modelInputTokens: positiveInteger,
  modelOutputTokens: positiveInteger,
  retries: positiveInteger,
  retainedSkillHistoryBytes: positiveBytes,
  retainedSkillsPerUser: positiveInteger,
  skillBodyBytes: positiveBytes,
  skillVersionBytes: positiveBytes,
  skillsChangedPerJob: positiveInteger,
});

/** One immutable operation catalog and its hard bounds. */
export const CapabilityCatalog = Schema.Struct({
  artifactKinds: Schema.Array(ArtifactKind),
  consequences: Schema.Array(ConsequenceClass),
  exhaustedConnectorRead: ExhaustedConnectorReadLimits,
  exhaustedConversation: ExhaustedConversationLimits,
  integrationReadLimits: IntegrationReadLimits,
  operationLimits: GovernedOperationLimits,
  operations: Schema.Array(GovernedAuthorizationOperationName),
  planExceptions: Schema.Struct({
    adventurer: Schema.Array(GovernedAuthorizationOperationName),
    free: Schema.Array(GovernedAuthorizationOperationName),
  }),
  planResourceLimits: Schema.Struct({
    adventurer: PlanResourceLimits,
    free: PlanResourceLimits,
  }),
  skillChanges: Schema.Array(SkillChange),
  skillLearning: SkillLearningLimits,
  version: CapabilityCatalogVersion,
});

/** One immutable operation catalog and its hard bounds. */
export type CapabilityCatalog = typeof CapabilityCatalog.Type;

/** Retained immutable capability catalogs with one explicit current version. */
export const CapabilityCatalogCollection = Schema.Struct({
  currentVersion: CapabilityCatalogVersion,
  catalogs: Schema.NonEmptyArray(CapabilityCatalog),
}).check(
  Schema.makeFilter(
    (collection) =>
      collection.catalogs.some((catalog) => catalog.version === collection.currentVersion) ||
      "currentVersion must select one retained Capability Catalog",
  ),
  Schema.makeFilter(
    (collection) =>
      new Set(collection.catalogs.map((catalog) => catalog.version)).size ===
        collection.catalogs.length || "Capability Catalog versions must be unique",
  ),
);

/** Expected denial when an admitted operation names no retained catalog. */
export class CapabilityCatalogNotFound extends Schema.TaggedError<CapabilityCatalogNotFound>()(
  "CapabilityCatalogNotFound",
  {
    message: Schema.String,
    version: CapabilityCatalogVersion,
  },
) {}

const governedCapabilitiesV1 = {
  artifactKinds: ["pdf", "docx", "pptx", "image", "diagram"],
  consequences: [
    "externalCommunication",
    "destructionOrOverwrite",
    "accessOrOwnershipChange",
    "financialCommitment",
    "futureOrRecurringExternalEffect",
    "humanEscalation",
  ],
  exhaustedConnectorRead: {
    attachments: 0,
    callsPerRollingDay: 20,
    concurrentReads: 1,
    deadlineMilliseconds: 10_000,
    pagination: 0,
    providerExecutions: 1,
    records: 10,
    responseBytes: 65_536n,
  },
  exhaustedConversation: {
    concurrentOperations: 1,
    inputTokens: 8_000,
    memoryDeadlineMilliseconds: 750,
    memoryProfileTokens: 200,
    memoryQueryTokens: 300,
    memoryRecalls: 1,
    modelSteps: 2,
    outputTokens: 1_024,
    retries: 0,
    skillInstructions: "locallyAvailableOnly",
  },
  integrationReadLimits: {
    recordsPerCall: 20,
    responseBytesPerCall: 65_536n,
    sequentialProviderCalls: 5,
    totalResponseBytes: 262_144n,
  },
  operationLimits: {
    computeInputBytes: 25_000_000n,
    computeMilliseconds: 60_000,
    csvInputRows: 100_000,
    durableArtifactOperationMilliseconds: 3_600_000,
    equivalentFallbackCandidatesPerModelStep: 1,
    filesPerUpload: 1,
    generatedDocumentBytes: 5_000_000n,
    generatedDocumentPages: 20,
    generatedImageBytes: 10_000_000n,
    generatedImagePixelsPerEdge: 2_048,
    generatedPresentationBytes: 20_000_000n,
    generatedPresentationSlides: 20,
    imageInputPixels: 40_000_000,
    interactiveOperationMilliseconds: 300_000,
    modelSteps: 12,
    normalizedTextBytes: 2_000_000n,
    officeArchiveEntries: 10_000,
    pdfInputPages: 500,
    recurringReminderMinimumIntervalMilliseconds: 86_400_000,
    researchArtifactCount: 1,
    researchOperationMilliseconds: 3_600_000,
    researchRetrievedPages: 20,
    researchSearches: 20,
    sameModelRetries: 0,
    uploadBytes: 25_000_000n,
    verifiedComputeOutputBytes: 20_000_000n,
    webNormalizedPageBytes: 256_000n,
    webPageBytes: 2_000_000n,
    webResultsPerSearch: 10,
    webRetrievedPages: 5,
    webSearches: 3,
  },
  operations: governedOperationNames,
  planExceptions: { adventurer: ["support.gmSummon"], free: [] },
  planResourceLimits: {
    adventurer: {
      activeGmSummonsPerSession: 1,
      activeReminders: 25,
      activeWorkflows: 25,
      concurrentCostlyJobs: 3,
      concurrentIntegrationEffects: 1,
      connectedAccountsPerToolkit: 1,
      gmSummonsPerPeriod: 1,
      managedModelInputTokens: 128_000,
      managedModelOutputTokens: 8_192,
      retainedUserContentBytes: 2_000_000_000n,
    },
    free: {
      activeGmSummonsPerSession: 0,
      activeReminders: 5,
      activeWorkflows: 3,
      concurrentCostlyJobs: 1,
      concurrentIntegrationEffects: 1,
      connectedAccountsPerToolkit: 1,
      gmSummonsPerPeriod: 0,
      managedModelInputTokens: 32_000,
      managedModelOutputTokens: 4_096,
      retainedUserContentBytes: 100_000_000n,
    },
  },
  skillChanges,
  skillLearning: {
    candidateBytes: 32_768n,
    candidateLifetimeMilliseconds: 86_400_000,
    candidatesPerUser: 1,
    concurrentJobsGlobally: 10,
    concurrentJobsPerUser: 1,
    jobsPerRollingDay: 3,
    modelInputTokens: 16_000,
    modelOutputTokens: 2_000,
    retries: 1,
    retainedSkillHistoryBytes: 5_000_000n,
    retainedSkillsPerUser: 100,
    skillBodyBytes: 8_192n,
    skillVersionBytes: 16_384n,
    skillsChangedPerJob: 1,
  },
  version: governedCapabilitiesV1Version,
};

/** Source-controlled immutable Capability Catalog history. */
export const retainedCapabilityCatalogs = Schema.decodeUnknownSync(CapabilityCatalogCollection)({
  catalogs: [governedCapabilitiesV1],
  currentVersion: governedCapabilitiesV1Version,
});

/** Current Capability Catalog selected only at operation admission. */
export const currentCapabilityCatalog = Schema.decodeUnknownSync(CapabilityCatalog)(
  retainedCapabilityCatalogs.catalogs.find(
    (catalog) => catalog.version === retainedCapabilityCatalogs.currentVersion,
  ),
);

/** Resolve one pinned catalog version without falling through to the current version. */
export const resolveCapabilityCatalog = (
  collection: typeof retainedCapabilityCatalogs,
  version: CapabilityCatalogVersion,
): Result.Result<CapabilityCatalog, CapabilityCatalogNotFound> => {
  const catalog = collection.catalogs.find((candidate) => candidate.version === version);
  return catalog === undefined
    ? Result.fail(
        new CapabilityCatalogNotFound({
          message: "The admitted operation names no retained Capability Catalog",
          version,
        }),
      )
    : Result.succeed(catalog);
};
