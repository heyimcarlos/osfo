CREATE TABLE "billing_checkout_sessions" (
	"billing_checkout_session_id" text PRIMARY KEY NOT NULL,
	"billing_customer_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"state" text NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_payment_status" text,
	"stripe_price_id" text NOT NULL,
	"stripe_product_id" text NOT NULL,
	"stripe_subscription_id" text,
	"target_plan" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "billing_checkout_sessions_stripe_session_id_unique" UNIQUE("stripe_checkout_session_id"),
	CONSTRAINT "billing_checkout_sessions_state_check" CHECK ("billing_checkout_sessions"."state" in ('creating', 'open', 'complete', 'expired', 'failed')),
	CONSTRAINT "billing_checkout_sessions_target_plan_check" CHECK ("billing_checkout_sessions"."target_plan" = 'adventurer')
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"billing_customer_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stripe_customer_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "billing_customers_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "billing_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "billing_customers_user_customer_unique" UNIQUE("user_id","billing_customer_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"billing_checkout_session_id" text,
	"error_code" text,
	"event_type" text NOT NULL,
	"external_event_id" text NOT NULL,
	"external_object_id" text NOT NULL,
	"processed_at" timestamp with time zone,
	"provider" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_event_id" text PRIMARY KEY NOT NULL,
	CONSTRAINT "webhook_events_provider_external_event_unique" UNIQUE("provider","external_event_id"),
	CONSTRAINT "webhook_events_attempts_check" CHECK ("webhook_events"."attempts" >= 0),
	CONSTRAINT "webhook_events_status_check" CHECK ("webhook_events"."status" in ('pending', 'processed', 'failed')),
	CONSTRAINT "webhook_events_processed_at_check" CHECK (("webhook_events"."status" = 'processed') = ("webhook_events"."processed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "allowance_periods" ADD COLUMN "stripe_invoice_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "billing_customer_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "pending_plan" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "pending_plan_effective_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_cancel_at_period_end" boolean;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_latest_invoice_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_product_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_status" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_user_customer_fk" FOREIGN KEY ("user_id","billing_customer_id") REFERENCES "public"."billing_customers"("user_id","billing_customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_customer_fk" FOREIGN KEY ("user_id","billing_customer_id") REFERENCES "public"."billing_customers"("user_id","billing_customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_periods" ADD CONSTRAINT "allowance_periods_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id");--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id");--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_pending_plan_pair_check" CHECK (("billing_subscriptions"."pending_plan" is null) = ("billing_subscriptions"."pending_plan_effective_at" is null));--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_stripe_identity_check" CHECK (("billing_subscriptions"."stripe_subscription_id" is null and "billing_subscriptions"."stripe_product_id" is null and "billing_subscriptions"."stripe_price_id" is null and "billing_subscriptions"."stripe_status" is null and "billing_subscriptions"."stripe_current_period_start" is null and "billing_subscriptions"."stripe_current_period_end" is null) or ("billing_subscriptions"."stripe_subscription_id" is not null and "billing_subscriptions"."stripe_product_id" is not null and "billing_subscriptions"."stripe_price_id" is not null and "billing_subscriptions"."stripe_status" is not null));--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_stripe_period_pair_check" CHECK (("billing_subscriptions"."stripe_current_period_start" is null) = ("billing_subscriptions"."stripe_current_period_end" is null));--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_stripe_period_bounds_check" CHECK ("billing_subscriptions"."stripe_current_period_start" is null or "billing_subscriptions"."stripe_current_period_start" < "billing_subscriptions"."stripe_current_period_end");--> statement-breakpoint
INSERT INTO "allowance_periods" (
  "allowance_period_id", "billing_subscription_id", "ends_at", "plan", "plan_policy_version", "starts_at", "user_id"
)
SELECT
  "period"."allowance_period_id" || ':free-cutover',
  "period"."billing_subscription_id",
  "period"."ends_at",
  'free',
  "period"."plan_policy_version",
  transaction_timestamp(),
  "period"."user_id"
FROM "allowance_periods" AS "period"
WHERE "period"."plan" = 'adventurer'
  AND "period"."starts_at" < transaction_timestamp()
  AND transaction_timestamp() < "period"."ends_at"
  AND EXISTS (
    SELECT 1
    FROM "billing_subscriptions" AS "subscription"
    WHERE "subscription"."billing_subscription_id" = "period"."billing_subscription_id"
      AND "subscription"."plan" = 'adventurer'
  );--> statement-breakpoint
UPDATE "allowance_periods" AS "period"
SET "ends_at" = transaction_timestamp()
WHERE "period"."plan" = 'adventurer'
  AND "period"."starts_at" < transaction_timestamp()
  AND transaction_timestamp() < "period"."ends_at"
  AND EXISTS (
    SELECT 1
    FROM "billing_subscriptions" AS "subscription"
    WHERE "subscription"."billing_subscription_id" = "period"."billing_subscription_id"
      AND "subscription"."plan" = 'adventurer'
  );--> statement-breakpoint
UPDATE "billing_subscriptions"
SET "plan" = 'free',
    "updated_at" = greatest(clock_timestamp(), "updated_at" + interval '1 microsecond')
WHERE "plan" = 'adventurer';--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_adventurer_evidence_check" CHECK ("billing_subscriptions"."plan" <> 'adventurer' or ("billing_subscriptions"."stripe_subscription_id" is not null and "billing_subscriptions"."stripe_current_period_start" is not null and "billing_subscriptions"."stripe_latest_invoice_id" is not null));
