import { Schema } from "effect";

/** Stable identity for one registered User. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));

/** Stable identity for one registered User. */
export type UserId = typeof UserId.Type;

/** Stable identity for one completed User Registration. */
export const RegistrationId = Schema.String.pipe(Schema.brand("RegistrationId"));

/** Stable identity for one completed User Registration. */
export type RegistrationId = typeof RegistrationId.Type;

/** Stable identity for one User-scoped Osfo Agent. */
export const AgentId = Schema.String.pipe(Schema.brand("AgentId"));

/** Stable identity for one User-scoped Osfo Agent. */
export type AgentId = typeof AgentId.Type;

/** Stable identity for one Subscription. */
export const SubscriptionId = Schema.String.pipe(Schema.brand("SubscriptionId"));

/** Stable identity for one Subscription. */
export type SubscriptionId = typeof SubscriptionId.Type;

/** Stable identity for one Usage Allowance period. */
export const AllowancePeriodId = Schema.String.pipe(Schema.brand("AllowancePeriodId"));

/** Stable identity for one Usage Allowance period. */
export type AllowancePeriodId = typeof AllowancePeriodId.Type;

/** Version identity for one launch Plan policy. */
export const PlanPolicyVersion = Schema.String.pipe(Schema.brand("PlanPolicyVersion"));

/** Version identity for one launch Plan policy. */
export type PlanPolicyVersion = typeof PlanPolicyVersion.Type;

/** Launch Plan names persisted by the directory. */
export const Plan = Schema.Literals(["free", "adventurer"]);

/** Launch Plan names persisted by the directory. */
export type Plan = typeof Plan.Type;
