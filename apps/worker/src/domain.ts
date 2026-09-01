import { Schema } from "effect";

export { ChannelLinkId } from "@osfo/api";

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

/** Stable identity for one AI SDK ToolCall owned by a Think Action or tool. */
export const ToolCallId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).pipe(
  Schema.brand("ToolCallId"),
);

/** Stable identity for one AI SDK ToolCall owned by a Think Action or tool. */
export type ToolCallId = typeof ToolCallId.Type;

/** Stable identity of one Think-owned bounded Submission. */
export const ThinkSubmissionId = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (value.length > 0 && value.length <= 160 && !value.includes(":")) ||
      "must be a bounded Think Submission identity without a colon",
  ),
).pipe(Schema.brand("ThinkSubmissionId"));

/** Stable identity of one Think-owned bounded Submission. */
export type ThinkSubmissionId = typeof ThinkSubmissionId.Type;

/** Stable identity for one billing Subscription. */
export const BillingSubscriptionId = Schema.String.pipe(Schema.brand("BillingSubscriptionId"));

/** Stable identity for one billing Subscription. */
export type BillingSubscriptionId = typeof BillingSubscriptionId.Type;

/** Stable local identity for one Stripe billing Customer association. */
export const BillingCustomerId = Schema.String.pipe(Schema.brand("BillingCustomerId"));

/** Stable local identity for one Stripe billing Customer association. */
export type BillingCustomerId = typeof BillingCustomerId.Type;

/** Stable local identity for one Stripe Checkout attempt. */
export const BillingCheckoutSessionId = Schema.String.pipe(
  Schema.brand("BillingCheckoutSessionId"),
);

/** Stable local identity for one Stripe Checkout attempt. */
export type BillingCheckoutSessionId = typeof BillingCheckoutSessionId.Type;

/** Verified Stripe Customer identity. */
export const StripeCustomerId = Schema.String.check(
  Schema.makeFilter((value) => /^cus_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Customer ID"),
).pipe(Schema.brand("StripeCustomerId"));

/** Verified Stripe Customer identity. */
export type StripeCustomerId = typeof StripeCustomerId.Type;

/** Verified Stripe Subscription identity. */
export const StripeSubscriptionId = Schema.String.check(
  Schema.makeFilter(
    (value) => /^sub_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Subscription ID",
  ),
).pipe(Schema.brand("StripeSubscriptionId"));

/** Verified Stripe Subscription identity. */
export type StripeSubscriptionId = typeof StripeSubscriptionId.Type;

/** Verified Stripe Product identity. */
export const StripeProductId = Schema.String.check(
  Schema.makeFilter((value) => /^prod_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Product ID"),
).pipe(Schema.brand("StripeProductId"));

/** Verified Stripe Product identity. */
export type StripeProductId = typeof StripeProductId.Type;

/** Verified Stripe Price identity. */
export const StripePriceId = Schema.String.check(
  Schema.makeFilter((value) => /^price_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Price ID"),
).pipe(Schema.brand("StripePriceId"));

/** Verified Stripe Price identity. */
export type StripePriceId = typeof StripePriceId.Type;

/** Verified Stripe Invoice identity. */
export const StripeInvoiceId = Schema.String.check(
  Schema.makeFilter((value) => /^in_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Invoice ID"),
).pipe(Schema.brand("StripeInvoiceId"));

/** Verified Stripe Invoice identity. */
export type StripeInvoiceId = typeof StripeInvoiceId.Type;

/** Verified Stripe Checkout Session identity. */
export const StripeCheckoutSessionId = Schema.String.check(
  Schema.makeFilter(
    (value) => /^cs_(?:test_|live_)?[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Checkout ID",
  ),
).pipe(Schema.brand("StripeCheckoutSessionId"));

/** Verified Stripe Checkout Session identity. */
export type StripeCheckoutSessionId = typeof StripeCheckoutSessionId.Type;

/** Stripe-assigned identity for one signature-verified webhook Event. */
export const StripeWebhookEventId = Schema.String.check(
  Schema.makeFilter((value) => /^evt_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Event ID"),
).pipe(Schema.brand("StripeWebhookEventId"));

/** Stripe-assigned identity for one signature-verified webhook Event. */
export type StripeWebhookEventId = typeof StripeWebhookEventId.Type;

/** Stripe-owned object identity carried by one signature-verified webhook Event. */
export const StripeWebhookObjectId = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 || "must not be empty"),
).pipe(Schema.brand("StripeWebhookObjectId"));

/** Stripe-owned object identity carried by one signature-verified webhook Event. */
export type StripeWebhookObjectId = typeof StripeWebhookObjectId.Type;

/** Osfo-local durable identity for one retained Stripe webhook record. */
export const StripeWebhookRecordId = Schema.String.pipe(Schema.brand("StripeWebhookRecordId"));

/** Osfo-local durable identity for one retained Stripe webhook record. */
export type StripeWebhookRecordId = typeof StripeWebhookRecordId.Type;

/** Verified Stripe Customer Portal configuration identity. */
export const StripePortalConfigurationId = Schema.String.check(
  Schema.makeFilter(
    (value) => /^bpc_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Portal Configuration ID",
  ),
).pipe(Schema.brand("StripePortalConfigurationId"));

/** Verified Stripe Customer Portal configuration identity. */
export type StripePortalConfigurationId = typeof StripePortalConfigurationId.Type;

/** Stable identity for one Usage Allowance period. */
export const AllowancePeriodId = Schema.String.pipe(Schema.brand("AllowancePeriodId"));

/** Stable identity for one Usage Allowance period. */
export type AllowancePeriodId = typeof AllowancePeriodId.Type;

/** Version identity persisted for one retained legacy or shared Usage policy. */
export const PlanPolicyVersion = Schema.String.pipe(Schema.brand("PlanPolicyVersion"));

/** Version identity persisted for one retained legacy or shared Usage policy. */
export type PlanPolicyVersion = typeof PlanPolicyVersion.Type;

/** Positive included Plan Usage pool owned by one shared policy. */
export const IncludedPlanUsageMicros = Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)).pipe(
  Schema.brand("IncludedPlanUsageMicros"),
);

/** Positive included Plan Usage pool owned by one shared policy. */
export type IncludedPlanUsageMicros = typeof IncludedPlanUsageMicros.Type;

/** Immutable provider price authority used to reproduce Rated Cost. */
export const ResourcePriceVersion = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("ResourcePriceVersion"),
);

/** Immutable provider price authority used to reproduce Rated Cost. */
export type ResourcePriceVersion = typeof ResourcePriceVersion.Type;

/** Immutable managed routing authority pinned at operation admission. */
export const ModelAccessPolicyVersion = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("ModelAccessPolicyVersion"),
);

/** Immutable managed routing authority pinned at operation admission. */
export type ModelAccessPolicyVersion = typeof ModelAccessPolicyVersion.Type;

/** Immutable capability and hard-limit authority pinned at operation admission. */
export const CapabilityCatalogVersion = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("CapabilityCatalogVersion"),
);

/** Immutable capability and hard-limit authority pinned at operation admission. */
export type CapabilityCatalogVersion = typeof CapabilityCatalogVersion.Type;

/** Immutable Integration Capability Manifest authority pinned at operation admission. */
export const ManifestVersion = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("ManifestVersion"),
);

/** Immutable Integration Capability Manifest authority pinned at operation admission. */
export type ManifestVersion = typeof ManifestVersion.Type;

/** Launch Plan names persisted by the directory. */
export const Plan = Schema.Literals(["free", "adventurer"]);

/** Launch Plan names persisted by the directory. */
export type Plan = typeof Plan.Type;
