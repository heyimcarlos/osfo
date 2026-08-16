import { Schema } from "effect";

/** Stable identity for one registered User. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));

/** Stable identity for one registered User. */
export type UserId = typeof UserId.Type;

/** Stable identity for one User-scoped Osfo Agent. */
export const AgentId = Schema.String.pipe(Schema.brand("AgentId"));

/** Stable identity for one User-scoped Osfo Agent. */
export type AgentId = typeof AgentId.Type;

/** Stable identity for one idempotent Osfo Agent initialization. */
export const AgentInitializationId = Schema.String.pipe(Schema.brand("AgentInitializationId"));

/** Stable identity for one idempotent Osfo Agent initialization. */
export type AgentInitializationId = typeof AgentInitializationId.Type;

/** Stable identity for one Agent-owned conversation route. */
export const ConversationRouteId = Schema.String.pipe(Schema.brand("ConversationRouteId"));

/** Stable identity for one Agent-owned conversation route. */
export type ConversationRouteId = typeof ConversationRouteId.Type;

/** Stable identity for one canonical Think Session. */
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));

/** Stable identity for one canonical Think Session. */
export type SessionId = typeof SessionId.Type;

/** Stable identity for one committed Think assistant message. */
export const AssistantMessageId = Schema.String.pipe(Schema.brand("AssistantMessageId"));

/** Stable identity for one committed Think assistant message. */
export type AssistantMessageId = typeof AssistantMessageId.Type;

/** Stable identity for one Think response request. */
export const ThinkRequestId = Schema.String.pipe(Schema.brand("ThinkRequestId"));

/** Stable identity for one Think response request. */
export type ThinkRequestId = typeof ThinkRequestId.Type;

/** Stable identity for one billing Subscription. */
export const BillingSubscriptionId = Schema.String.pipe(Schema.brand("BillingSubscriptionId"));

/** Stable identity for one billing Subscription. */
export type BillingSubscriptionId = typeof BillingSubscriptionId.Type;

/** Stable identity for one Usage Allowance period. */
export const AllowancePeriodId = Schema.String.pipe(Schema.brand("AllowancePeriodId"));

/** Stable identity for one Usage Allowance period. */
export type AllowancePeriodId = typeof AllowancePeriodId.Type;

/** Stable identity for one finite-lived Registration Invitation. */
export const RegistrationInvitationId = Schema.String.pipe(
  Schema.brand("RegistrationInvitationId"),
);

/** Stable identity for one finite-lived Registration Invitation. */
export type RegistrationInvitationId = typeof RegistrationInvitationId.Type;

/** Stable identity for one revocable Channel Binding. */
export const ChannelBindingId = Schema.String.pipe(Schema.brand("ChannelBindingId"));

/** Stable identity for one revocable Channel Binding. */
export type ChannelBindingId = typeof ChannelBindingId.Type;

/** One authenticated provider identity, separate from a User or Phone Account. */
export const ChannelIdentity = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 || "must not be empty"),
).pipe(Schema.brand("ChannelIdentity"));

/** One authenticated provider identity, separate from a User or Phone Account. */
export type ChannelIdentity = typeof ChannelIdentity.Type;

/** Version identity for one launch Plan policy. */
export const PlanPolicyVersion = Schema.String.pipe(Schema.brand("PlanPolicyVersion"));

/** Version identity for one launch Plan policy. */
export type PlanPolicyVersion = typeof PlanPolicyVersion.Type;

/** Launch Plan names persisted by the directory. */
export const Plan = Schema.Literals(["free", "adventurer"]);

/** Launch Plan names persisted by the directory. */
export type Plan = typeof Plan.Type;
