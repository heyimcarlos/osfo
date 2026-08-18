CREATE TABLE "agents" (
	"agent_id" text NOT NULL,
	"created_at" text NOT NULL,
	"user_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allowance_periods" (
	"allowance_period_id" text PRIMARY KEY NOT NULL,
	"billing_subscription_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"plan" text NOT NULL,
	"plan_policy_version" text NOT NULL,
	"stripe_invoice_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "allowance_periods_user_start_unique" UNIQUE("user_id","starts_at"),
	CONSTRAINT "allowance_periods_user_period_unique" UNIQUE("user_id","allowance_period_id"),
	CONSTRAINT "allowance_periods_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id"),
	CONSTRAINT "allowance_periods_starts_before_ends_check" CHECK ("allowance_periods"."starts_at" < "allowance_periods"."ends_at")
);
--> statement-breakpoint
CREATE TABLE "allowance_usage" (
	"allowance_kind" text NOT NULL,
	"allowance_period_id" text NOT NULL,
	"basis" text NOT NULL,
	"quantity" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "allowance_usage_pk" PRIMARY KEY("allowance_period_id","allowance_kind","source_type","source_id"),
	CONSTRAINT "allowance_usage_positive_quantity_check" CHECK ("allowance_usage"."quantity" > 0),
	CONSTRAINT "allowance_usage_basis_check" CHECK ("allowance_usage"."basis" in ('known_at_start', 'observed', 'conservative'))
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"phone_number" text,
	"phone_number_verified" boolean,
	"help_areas" text[] DEFAULT '{}' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"preferred_name" text,
	"registration_completed_at" timestamp,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "billing_subscriptions" (
	"billing_subscription_id" text PRIMARY KEY NOT NULL,
	"billing_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_plan" text,
	"pending_plan_effective_at" timestamp with time zone,
	"plan" text NOT NULL,
	"plan_policy_version" text NOT NULL,
	"stripe_cancel_at_period_end" boolean,
	"stripe_current_period_end" timestamp with time zone,
	"stripe_current_period_start" timestamp with time zone,
	"stripe_latest_invoice_id" text,
	"stripe_price_id" text,
	"stripe_product_id" text,
	"stripe_status" text,
	"stripe_subscription_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "billing_subscriptions_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "billing_subscriptions_user_subscription_unique" UNIQUE("user_id","billing_subscription_id"),
	CONSTRAINT "billing_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "billing_subscriptions_pending_plan_pair_check" CHECK (("billing_subscriptions"."pending_plan" is null) = ("billing_subscriptions"."pending_plan_effective_at" is null)),
	CONSTRAINT "billing_subscriptions_stripe_identity_check" CHECK (("billing_subscriptions"."stripe_subscription_id" is null and "billing_subscriptions"."stripe_product_id" is null and "billing_subscriptions"."stripe_price_id" is null and "billing_subscriptions"."stripe_status" is null and "billing_subscriptions"."stripe_current_period_start" is null and "billing_subscriptions"."stripe_current_period_end" is null) or ("billing_subscriptions"."stripe_subscription_id" is not null and "billing_subscriptions"."stripe_product_id" is not null and "billing_subscriptions"."stripe_price_id" is not null and "billing_subscriptions"."stripe_status" is not null)),
	CONSTRAINT "billing_subscriptions_stripe_period_pair_check" CHECK (("billing_subscriptions"."stripe_current_period_start" is null) = ("billing_subscriptions"."stripe_current_period_end" is null)),
	CONSTRAINT "billing_subscriptions_stripe_period_bounds_check" CHECK ("billing_subscriptions"."stripe_current_period_start" is null or "billing_subscriptions"."stripe_current_period_start" < "billing_subscriptions"."stripe_current_period_end"),
	CONSTRAINT "billing_subscriptions_adventurer_evidence_check" CHECK ("billing_subscriptions"."plan" <> 'adventurer' or ("billing_subscriptions"."stripe_subscription_id" is not null and "billing_subscriptions"."stripe_current_period_start" is not null and "billing_subscriptions"."stripe_latest_invoice_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "channel_bindings" (
	"channel_binding_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"channel_identity" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "channel_bindings_provider_check" CHECK ("channel_bindings"."provider" in ('telegram', 'whatsapp'))
);
--> statement-breakpoint
CREATE TABLE "registration_invitations" (
	"invitation_id" text PRIMARY KEY NOT NULL,
	"token_digest" text NOT NULL,
	"kind" text DEFAULT 'whatsapp_first' NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text,
	"channel_identity" text,
	"invited_phone_number" text,
	"locale" text NOT NULL,
	"state" text DEFAULT 'live' NOT NULL,
	"expiry_reason" text,
	"consumption_digest" text,
	"binding_outcome" text,
	"channel_binding_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "registration_invitations_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "registration_invitations_provider_check" CHECK ("registration_invitations"."provider" in ('telegram', 'whatsapp')),
	CONSTRAINT "registration_invitations_kind_check" CHECK ("registration_invitations"."kind" in ('telegram_first', 'whatsapp_first', 'web_enrollment')),
	CONSTRAINT "registration_invitations_state_check" CHECK ("registration_invitations"."state" in ('live', 'consumed', 'expired')),
	CONSTRAINT "registration_invitations_expiry_reason_check" CHECK (("registration_invitations"."state" = 'expired' and "registration_invitations"."expiry_reason" in ('elapsed', 'replaced')) or ("registration_invitations"."state" <> 'expired' and "registration_invitations"."expiry_reason" is null)),
	CONSTRAINT "registration_invitations_consumption_digest_check" CHECK (("registration_invitations"."state" = 'consumed' and "registration_invitations"."consumption_digest" is not null) or ("registration_invitations"."state" <> 'consumed' and "registration_invitations"."consumption_digest" is null)),
	CONSTRAINT "registration_invitations_binding_outcome_check" CHECK ("registration_invitations"."binding_outcome" is null or "registration_invitations"."binding_outcome" in ('created', 'existing', 'refused')),
	CONSTRAINT "registration_invitations_binding_receipt_check" CHECK (("registration_invitations"."binding_outcome" in ('created', 'existing') and "registration_invitations"."channel_binding_id" is not null) or ("registration_invitations"."binding_outcome" = 'refused' and "registration_invitations"."channel_binding_id" is null) or ("registration_invitations"."binding_outcome" is null and "registration_invitations"."channel_binding_id" is null)),
	CONSTRAINT "registration_invitations_lifecycle_check" CHECK (("registration_invitations"."state" = 'live' and "registration_invitations"."consumed_at" is null) or ("registration_invitations"."state" = 'consumed' and "registration_invitations"."consumed_at" is not null) or ("registration_invitations"."state" = 'expired' and "registration_invitations"."consumed_at" is null)),
	CONSTRAINT "registration_invitations_expiry_check" CHECK ("registration_invitations"."created_at" < "registration_invitations"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "deletion_cases" (
	"deletion_case_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"requested_by_admin_id" text NOT NULL,
	"reason" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_cases_actor_check" CHECK (length(btrim("deletion_cases"."requested_by_admin_id")) > 0),
	CONSTRAINT "deletion_cases_reason_check" CHECK (length(btrim("deletion_cases"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "user_suspension_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"admin_actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_suspension_events_action_check" CHECK ("user_suspension_events"."action" in ('suspended', 'restored')),
	CONSTRAINT "user_suspension_events_actor_check" CHECK (length(btrim("user_suspension_events"."admin_actor_id")) > 0),
	CONSTRAINT "user_suspension_events_reason_check" CHECK (length(btrim("user_suspension_events"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_type" text NOT NULL,
	"external_event_id" text NOT NULL,
	"payload_json" text NOT NULL,
	"provider" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_event_id" text PRIMARY KEY NOT NULL,
	CONSTRAINT "webhook_events_provider_external_event_unique" UNIQUE("provider","external_event_id"),
	CONSTRAINT "webhook_events_provider_check" CHECK ("webhook_events"."provider" = 'stripe')
);
--> statement-breakpoint
CREATE TABLE "webhook_jobs" (
	"attempts" integer DEFAULT 1 NOT NULL,
	"error_code" text,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_event_id" text PRIMARY KEY NOT NULL,
	CONSTRAINT "webhook_jobs_attempts_check" CHECK ("webhook_jobs"."attempts" >= 1),
	CONSTRAINT "webhook_jobs_status_check" CHECK ("webhook_jobs"."status" in ('pending', 'processed', 'failed')),
	CONSTRAINT "webhook_jobs_processed_at_check" CHECK (("webhook_jobs"."status" = 'processed') = ("webhook_jobs"."processed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_periods" ADD CONSTRAINT "allowance_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_periods" ADD CONSTRAINT "allowance_periods_user_subscription_fk" FOREIGN KEY ("user_id","billing_subscription_id") REFERENCES "public"."billing_subscriptions"("user_id","billing_subscription_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_usage" ADD CONSTRAINT "allowance_usage_user_period_fk" FOREIGN KEY ("user_id","allowance_period_id") REFERENCES "public"."allowance_periods"("user_id","allowance_period_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_user_customer_fk" FOREIGN KEY ("user_id","billing_customer_id") REFERENCES "public"."billing_customers"("user_id","billing_customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_customer_fk" FOREIGN KEY ("user_id","billing_customer_id") REFERENCES "public"."billing_customers"("user_id","billing_customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_invitations" ADD CONSTRAINT "registration_invitations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_cases" ADD CONSTRAINT "deletion_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_suspension_events" ADD CONSTRAINT "user_suspension_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_jobs" ADD CONSTRAINT "webhook_jobs_event_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("webhook_event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_agent_id_unique" ON "agents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "allowance_periods_user_bounds_index" ON "allowance_periods" USING btree ("user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "allowance_usage_period_kind_index" ON "allowance_usage" USING btree ("allowance_period_id","allowance_kind");--> statement-breakpoint
CREATE INDEX "accounts_userId_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_userId_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_active_identity_unique" ON "channel_bindings" USING btree ("provider","channel_identity") WHERE "channel_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_active_user_unique" ON "channel_bindings" USING btree ("provider","user_id") WHERE "channel_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "channel_bindings_user_index" ON "channel_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "registration_invitations_expiry_index" ON "registration_invitations" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitations_provider_event_unique" ON "registration_invitations" USING btree ("provider","provider_event_id") WHERE "registration_invitations"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitations_live_channel_unique" ON "registration_invitations" USING btree ("provider","channel_identity") WHERE "registration_invitations"."state" = 'live' and "registration_invitations"."channel_identity" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitations_live_web_user_unique" ON "registration_invitations" USING btree ("user_id","kind") WHERE "registration_invitations"."state" = 'live' and "registration_invitations"."kind" = 'web_enrollment' and "registration_invitations"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_cases_user_unique" ON "deletion_cases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_suspension_events_user_order_index" ON "user_suspension_events" USING btree ("user_id","occurred_at","event_id");