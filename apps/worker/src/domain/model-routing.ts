import { Result, Schema } from "effect";

import { ModelAccessPolicyVersion } from "../domain";

/** Deterministic product facts supplied to managed routing. */
export const TaskRequirements = Schema.Struct({
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  modality: Schema.Literals(["text", "image", "mixed"]),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stepBudget: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
  structuredOutput: Schema.Boolean,
  toolUse: Schema.Boolean,
  userDescription: Schema.NullOr(Schema.String),
  verifier: Schema.Literals(["none", "deterministic"]),
  workflowQuality: Schema.Literals(["routine", "frontier"]),
});

/** Deterministic product facts supplied to managed routing. */
export type TaskRequirements = typeof TaskRequirements.Type;

export const RouteProfile = Schema.Literals([
  "exhaustedConversation",
  "freeNormal",
  "adventurerRoutine",
  "adventurerFrontier",
]);

export type RouteProfile = typeof RouteProfile.Type;

export class RoutingDecisionDenied extends Schema.TaggedError<RoutingDecisionDenied>()(
  "RoutingDecisionDenied",
  { message: Schema.String },
) {}

/** Inactive immutable routing policy retained until its compatibility and quality gates pass. */
export const currentModelRoutingPolicy = {
  activation: {
    proof: {
      cancellation: false,
      equivalentFallback: false,
      gatewayLogs: false,
      selectedModelAndProvider: false,
      streaming: false,
      structuredOutput: false,
      tokenEvidence: false,
      toolCalls: false,
    },
    status: "MISSING" as const,
  },
  dynamicRouteName: "osfo-managed-routing-v1",
  equivalentFallbackCandidatesPerStep: 1,
  executionPlane: "directWorkersAi" as const,
  metadataKeys: ["route_profile", "policy_version", "routing_subject", "operation_id"] as const,
  sameModelRetries: 0,
  version: ModelAccessPolicyVersion.make("managed-routing-v1"),
};

/** Select one profile from trusted, bounded requirements. */
export const chooseRouteProfile = (
  plan: "free" | "adventurer",
  requirements: TaskRequirements,
  exhausted: boolean,
): RouteProfile => {
  if (exhausted) return "exhaustedConversation";
  if (plan === "free") return "freeNormal";
  return requirements.workflowQuality === "frontier" ||
    requirements.inputTokens > 64_000 ||
    requirements.outputTokens > 4_096
    ? "adventurerFrontier"
    : "adventurerRoutine";
};

/** Apply the single allowed quality escalation; provider fallback is not escalation. */
export const routeAfterAttempt = (attempt: {
  readonly escalationCount: 0 | 1;
  readonly profile: RouteProfile;
  readonly reason: "providerFallback" | "reliabilityInsufficient" | "verifierRejected";
}): Result.Result<
  { readonly escalationCount: 1; readonly profile: "adventurerFrontier" },
  RoutingDecisionDenied
> =>
  attempt.profile === "adventurerRoutine" &&
  attempt.escalationCount === 0 &&
  attempt.reason !== "providerFallback"
    ? Result.succeed({ escalationCount: 1, profile: "adventurerFrontier" })
    : Result.fail(
        new RoutingDecisionDenied({
          message: "No further quality escalation is permitted for this root operation",
        }),
      );

/** Apply the Model Quality Gate before a stronger-route outage can downgrade. */
export const handleStrongerRouteOutage = (
  profile: RouteProfile,
  quality: { readonly lowerProfileQualified: boolean },
) =>
  profile === "adventurerFrontier" && quality.lowerProfileQualified
    ? { _tag: "UseLowerProfile" as const, profile: "adventurerRoutine" as const }
    : { _tag: "Pause" as const, reason: "strongerRouteUnavailable" as const };
