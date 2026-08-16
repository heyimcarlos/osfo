import { Effect, Schema } from "effect";

import { Plan, PlanPolicyVersion } from "../domain";

const PositiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));

/** Server-owned Cloudflare AI Gateway route selected by Osfo policy. */
export const ManagedModelRoute = Schema.String.check(
  Schema.makeFilter(
    (value) => /^dynamic\/[a-z0-9-]+$/.test(value) || "must name one dynamic AI Gateway route",
  ),
).pipe(Schema.brand("ManagedModelRoute"));

/** Server-owned Cloudflare AI Gateway route selected by Osfo policy. */
export type ManagedModelRoute = typeof ManagedModelRoute.Type;

/** Bounded context contract required from one managed route. */
export const ManagedContextPolicy = Schema.Struct({
  maxInputTokens: PositiveInteger,
  maxOutputTokens: PositiveInteger,
  targetInputTokens: PositiveInteger,
}).check(
  Schema.makeFilter(
    (context) =>
      context.targetInputTokens < context.maxInputTokens ||
      "targetInputTokens must remain below maxInputTokens",
  ),
);

/** One immutable managed route profile. */
export const ManagedRouteProfile = Schema.Struct({
  context: ManagedContextPolicy,
  maxRetries: Schema.Literal(0),
  maxSteps: PositiveInteger,
  maxVendorUsdMicros: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
  route: ManagedModelRoute,
});

/** One immutable managed route profile. */
export type ManagedRouteProfile = typeof ManagedRouteProfile.Type;

/** Versioned server-owned model route policy for both launch Plans. */
export const ModelAccessPolicy = Schema.Struct({
  planPolicyVersion: PlanPolicyVersion,
  plans: Schema.Struct({
    adventurer: ManagedRouteProfile,
    free: ManagedRouteProfile,
  }),
});

/** Versioned server-owned model route policy for both launch Plans. */
export type ModelAccessPolicy = typeof ModelAccessPolicy.Type;

/** Expected denial when retained Plan history has no matching model route. */
export class ManagedRouteUnavailable extends Schema.TaggedError<ManagedRouteUnavailable>()(
  "ManagedRouteUnavailable",
  {
    message: Schema.String,
    plan: Plan,
    planPolicyVersion: PlanPolicyVersion,
  },
) {}

/** Retained launch model route policy. */
export const launchModelAccessPolicy = Schema.decodeSync(ModelAccessPolicy)({
  planPolicyVersion: "launch-v1",
  plans: {
    adventurer: {
      context: {
        maxInputTokens: 128_000,
        maxOutputTokens: 8_192,
        targetInputTokens: 72_000,
      },
      maxRetries: 0,
      maxSteps: 12,
      maxVendorUsdMicros: 750_000n,
      route: "dynamic/osfo-adventurer-v1",
    },
    free: {
      context: {
        maxInputTokens: 32_000,
        maxOutputTokens: 4_096,
        targetInputTokens: 18_000,
      },
      maxRetries: 0,
      maxSteps: 6,
      maxVendorUsdMicros: 30_000n,
      route: "dynamic/osfo-free-v1",
    },
  },
});

/** Select the exact managed route pinned by one admitted Plan policy version. */
export const selectManagedRoute = (
  policy: ModelAccessPolicy,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
): Effect.Effect<ManagedRouteProfile, ManagedRouteUnavailable> =>
  planPolicyVersion === policy.planPolicyVersion
    ? Effect.succeed(policy.plans[plan])
    : Effect.fail(
        new ManagedRouteUnavailable({
          message: "The admitted Plan policy has no managed model route",
          plan,
          planPolicyVersion,
        }),
      );
