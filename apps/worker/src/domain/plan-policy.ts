import { Effect, Schema } from "effect";

import { IncludedPlanUsageMicros, PlanPolicyVersion } from "../domain";

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

/** Immutable retained launch rules for one Plan. */
export const PlanRules = Schema.Struct({
  allowanceLimits: AllowanceLimits,
  entitlements: Schema.Array(Capability),
  liveLimits: LiveLimits,
  operationLimits: OperationLimits,
});

/** Immutable retained launch rules for one Plan. */
export type PlanRules = typeof PlanRules.Type;

/** The delivered capability-specific policy retained for historical interpretation. */
export const LaunchPlanPolicy = Schema.Struct({
  plans: Schema.Struct({ adventurer: PlanRules, free: PlanRules }),
  version: Schema.Literal("launch-v1").pipe(Schema.brand("PlanPolicyVersion")),
});

/** The delivered capability-specific policy retained for historical interpretation. */
export type LaunchPlanPolicy = typeof LaunchPlanPolicy.Type;

/** Included noncash Plan Usage owned by one shared-Usage Plan policy. */
export const SharedUsagePlanRules = Schema.Struct({
  includedPlanUsageMicros: IncludedPlanUsageMicros,
});

/** Included noncash Plan Usage owned by one shared-Usage Plan policy. */
export type SharedUsagePlanRules = typeof SharedUsagePlanRules.Type;

/** One immutable shared Plan Usage policy with no capability-specific counters. */
export const SharedUsagePlanPolicy = Schema.Struct({
  plans: Schema.Struct({ adventurer: SharedUsagePlanRules, free: SharedUsagePlanRules }),
  ratedCostUsdMicroToPlanUsageMicro: Schema.Literal(1n),
  version: Schema.Literal("shared-usage-v1").pipe(Schema.brand("PlanPolicyVersion")),
});

/** One immutable shared Plan Usage policy with no capability-specific counters. */
export type SharedUsagePlanPolicy = typeof SharedUsagePlanPolicy.Type;

/** One retained immutable legacy or shared Plan policy. */
export const PlanPolicy = Schema.Union([LaunchPlanPolicy, SharedUsagePlanPolicy]);

/** One retained immutable legacy or shared Plan policy. */
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
    {
      plans: {
        adventurer: { includedPlanUsageMicros: 6_000_000n },
        free: { includedPlanUsageMicros: 2_000_000n },
      },
      ratedCostUsdMicroToPlanUsageMicro: 1n,
      version: "shared-usage-v1",
    },
  ],
};

/** Parse one policy catalog before it becomes application authority. */
// oxlint-disable-next-line osfo/no-unknown-parameters -- This function is the schema parser at the policy boundary.
export const parseCatalog = (input: unknown) =>
  Schema.decodeUnknownEffect(PlanPolicyCatalog, { onExcessProperty: "error" })(input).pipe(
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

/** Immutable shared Usage policy retained for new Free-period and replay calculations. */
export const sharedUsagePolicyV1 = Schema.decodeUnknownSync(SharedUsagePlanPolicy)(
  retainedCatalog.policies.find((policy) => policy.version === "shared-usage-v1"),
);

/** Current source-controlled Plan policy. */
export const currentPolicy = Schema.decodeUnknownSync(PlanPolicy)(
  retainedCatalog.policies.find((policy) => policy.version === retainedCatalog.currentVersion),
);

/** Currently active launch policy while shared Usage activation evidence is MISSING. */
export const currentLaunchPolicy = Schema.decodeUnknownSync(LaunchPlanPolicy)(currentPolicy);

/** Read one Plan entry from a parsed policy. */
export function policyFor(policy: LaunchPlanPolicy, plan: "adventurer" | "free"): PlanRules;
export function policyFor(
  policy: SharedUsagePlanPolicy,
  plan: "adventurer" | "free",
): SharedUsagePlanRules;
export function policyFor(
  policy: PlanPolicy,
  plan: "adventurer" | "free",
): PlanRules | SharedUsagePlanRules;
export function policyFor(policy: PlanPolicy, plan: "adventurer" | "free") {
  return policy.plans[plan];
}

/** Prove a retained policy uses the delivered launch shape. */
export const isLaunchPolicy = (policy: PlanPolicy): policy is LaunchPlanPolicy =>
  policy.version === "launch-v1";

/** Prove a retained policy uses the shared Plan Usage shape. */
export const isSharedUsagePolicy = (policy: PlanPolicy): policy is SharedUsagePlanPolicy =>
  policy.version === "shared-usage-v1";

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
