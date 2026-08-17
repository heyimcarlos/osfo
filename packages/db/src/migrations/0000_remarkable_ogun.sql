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
	"starts_at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "allowance_periods_user_start_unique" UNIQUE("user_id","starts_at"),
	CONSTRAINT "allowance_periods_user_period_unique" UNIQUE("user_id","allowance_period_id"),
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
CREATE TABLE "billing_subscriptions" (
	"billing_subscription_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan" text NOT NULL,
	"plan_policy_version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "billing_subscriptions_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "billing_subscriptions_user_subscription_unique" UNIQUE("user_id","billing_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_periods" ADD CONSTRAINT "allowance_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_periods" ADD CONSTRAINT "allowance_periods_user_subscription_fk" FOREIGN KEY ("user_id","billing_subscription_id") REFERENCES "public"."billing_subscriptions"("user_id","billing_subscription_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_usage" ADD CONSTRAINT "allowance_usage_user_period_fk" FOREIGN KEY ("user_id","allowance_period_id") REFERENCES "public"."allowance_periods"("user_id","allowance_period_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_agent_id_unique" ON "agents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "allowance_periods_user_bounds_index" ON "allowance_periods" USING btree ("user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "allowance_usage_period_kind_index" ON "allowance_usage" USING btree ("allowance_period_id","allowance_kind");--> statement-breakpoint
CREATE INDEX "accounts_userId_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_userId_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");