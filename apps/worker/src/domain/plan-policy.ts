import { Effect, Schema } from "effect";

import { PlanPolicyVersion } from "../domain";

const NonNegativeLimit = Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n));

/** Launch capabilities controlled by Plan Entitlement. */
export const Capability = Schema.Literals([
  "conversation",
  "documents",
  "files",
  "gmail",
  "gmSummon",
  "memory",
  "oneTimeReminders",
  "recurringReminders",
  "researchReports",
  "session",
  "workflows",
]);

/** Launch capabilities controlled by Plan Entitlement. */
export type Capability = typeof Capability.Type;

/** Period allowance limits owned by one Plan policy. */
export const AllowanceLimits = Schema.Struct({
  acceptedMessages: NonNegativeLimit,
  fileUploads: NonNegativeLimit,
  generatedDocuments: NonNegativeLimit,
  gmailMessagesExamined: NonNegativeLimit,
  gmailSearches: NonNegativeLimit,
  gmailSends: NonNegativeLimit,
  gmSummons: NonNegativeLimit,
  reminderDeliveries: NonNegativeLimit,
  researchReports: NonNegativeLimit,
  supermemoryIngestionTokens: NonNegativeLimit,
  supermemoryRetrievals: NonNegativeLimit,
  vendorUsdMicros: NonNegativeLimit,
  workflowStarts: NonNegativeLimit,
});

/** Period allowance limits owned by one Plan policy. */
export type AllowanceLimits = typeof AllowanceLimits.Type;

/** Per-operation limits owned by one Plan policy. */
export const OperationLimits = Schema.Struct({
  documentBytes: NonNegativeLimit,
  documentPages: NonNegativeLimit,
  modelStepsPerRequest: NonNegativeLimit,
  researchSearches: NonNegativeLimit,
  uploadBytes: NonNegativeLimit,
  vendorUsdMicrosPerRequest: NonNegativeLimit,
});

/** Per-operation limits owned by one Plan policy. */
export type OperationLimits = typeof OperationLimits.Type;

/** Live resource limits enforced by the module that owns each resource. */
export const LiveLimits = Schema.Struct({
  activeGmSummonsPerSession: NonNegativeLimit,
  activeReminders: NonNegativeLimit,
  concurrentWorkflows: NonNegativeLimit,
  retainedFileBytes: NonNegativeLimit,
});

/** Live resource limits enforced by the module that owns each resource. */
export type LiveLimits = typeof LiveLimits.Type;

/** Immutable launch rules for one Plan. */
export const PlanRules = Schema.Struct({
  allowanceLimits: AllowanceLimits,
  entitlements: Schema.Array(Capability),
  liveLimits: LiveLimits,
  operationLimits: OperationLimits,
});

/** Immutable launch rules for one Plan. */
export type PlanRules = typeof PlanRules.Type;

/** One retained, immutable Plan policy version. */
export const PlanPolicy = Schema.Struct({
  plans: Schema.Struct({ adventurer: PlanRules, free: PlanRules }),
  version: PlanPolicyVersion,
});

/** One retained, immutable Plan policy version. */
export type PlanPolicy = typeof PlanPolicy.Type;

/** Source-controlled catalog of retained Plan policies and its explicit current version. */
export const PlanPolicyCatalog = Schema.Struct({
  currentVersion: PlanPolicyVersion,
  policies: Schema.NonEmptyArray(PlanPolicy),
}).check(
  Schema.makeFilter(
    (catalog) =>
      catalog.policies.some((policy) => policy.version === catalog.currentVersion) ||
      "currentVersion must select one retained Plan policy",
  ),
  Schema.makeFilter(
    (catalog) =>
      new Set(catalog.policies.map((policy) => policy.version)).size === catalog.policies.length ||
      "retained Plan policy versions must be unique",
  ),
);

/** Source-controlled catalog of retained Plan policies and its explicit current version. */
export type PlanPolicyCatalog = typeof PlanPolicyCatalog.Type;

/** Expected startup failure for an invalid source-controlled Plan policy catalog. */
export class InvalidPlanPolicyCatalog extends Schema.TaggedError<InvalidPlanPolicyCatalog>()(
  "InvalidPlanPolicyCatalog",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Expected failure when persisted period history names no retained policy. */
export class PlanPolicyNotFound extends Schema.TaggedError<PlanPolicyNotFound>()(
  "PlanPolicyNotFound",
  {
    message: Schema.String,
    version: PlanPolicyVersion,
  },
) {}

/** Source-shaped catalog input that must be parsed before it becomes policy authority. */
export interface PlanPolicyCatalogSource {
  readonly currentVersion: string;
  readonly policies: ReadonlyArray<{
    readonly plans: {
      readonly adventurer?: typeof PlanRules.Encoded;
      readonly free?: typeof PlanRules.Encoded;
    };
    readonly version: string;
  }>;
}

const launchCatalog = {
  currentVersion: "launch-v1",
  policies: [
    {
      plans: {
        adventurer: {
          allowanceLimits: {
            acceptedMessages: 300n,
            fileUploads: 100n,
            generatedDocuments: 10n,
            gmailMessagesExamined: 500n,
            gmailSearches: 50n,
            gmailSends: 20n,
            gmSummons: 1n,
            reminderDeliveries: 100n,
            researchReports: 5n,
            supermemoryIngestionTokens: 250_000n,
            supermemoryRetrievals: 2_000n,
            vendorUsdMicros: 7_500_000n,
            workflowStarts: 40n,
          },
          entitlements: [
            "conversation",
            "session",
            "memory",
            "files",
            "oneTimeReminders",
            "documents",
            "researchReports",
            "recurringReminders",
            "workflows",
            "gmail",
            "gmSummon",
          ],
          liveLimits: {
            activeGmSummonsPerSession: 1n,
            activeReminders: 25n,
            concurrentWorkflows: 3n,
            retainedFileBytes: 2_000_000_000n,
          },
          operationLimits: {
            documentBytes: 5_000_000n,
            documentPages: 20n,
            modelStepsPerRequest: 12n,
            researchSearches: 20n,
            uploadBytes: 25_000_000n,
            vendorUsdMicrosPerRequest: 750_000n,
          },
        },
        free: {
          allowanceLimits: {
            acceptedMessages: 30n,
            fileUploads: 10n,
            generatedDocuments: 0n,
            gmailMessagesExamined: 0n,
            gmailSearches: 0n,
            gmailSends: 0n,
            gmSummons: 0n,
            reminderDeliveries: 3n,
            researchReports: 0n,
            supermemoryIngestionTokens: 10_000n,
            supermemoryRetrievals: 100n,
            vendorUsdMicros: 250_000n,
            workflowStarts: 0n,
          },
          entitlements: ["conversation", "session", "memory", "files", "oneTimeReminders"],
          liveLimits: {
            activeGmSummonsPerSession: 0n,
            activeReminders: 1n,
            concurrentWorkflows: 0n,
            retainedFileBytes: 100_000_000n,
          },
          operationLimits: {
            documentBytes: 0n,
            documentPages: 0n,
            modelStepsPerRequest: 6n,
            researchSearches: 0n,
            uploadBytes: 10_000_000n,
            vendorUsdMicrosPerRequest: 30_000n,
          },
        },
      },
      version: "launch-v1",
    },
  ],
};

/** Parse one policy catalog before it becomes application authority. */
export const parseCatalog = (input: PlanPolicyCatalogSource) =>
  Schema.decodeUnknownEffect(PlanPolicyCatalog)(input).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidPlanPolicyCatalog({
          cause,
          message: "The Plan policy catalog is invalid",
        }),
    ),
  );

/** Retained source-controlled Plan policy catalog. */
export const retainedCatalog = Schema.decodeUnknownSync(PlanPolicyCatalog)(launchCatalog);

/** Current source-controlled Plan policy. */
export const currentPolicy = Schema.decodeUnknownSync(PlanPolicy)(
  retainedCatalog.policies.find((policy) => policy.version === retainedCatalog.currentVersion),
);

/** Read one Plan entry from a parsed policy. */
export const policyFor = (policy: PlanPolicy, plan: "adventurer" | "free"): PlanRules =>
  policy.plans[plan];

/** Resolve one retained policy version for persisted allowance history. */
export const policyForVersion = (catalog: PlanPolicyCatalog, version: PlanPolicyVersion) => {
  return Effect.gen(function* () {
    const policy = catalog.policies.find((candidate) => candidate.version === version);
    if (policy === undefined) {
      return yield* new PlanPolicyNotFound({
        message: "The allowance period names no retained Plan policy",
        version,
      });
    }
    return policy;
  });
};
