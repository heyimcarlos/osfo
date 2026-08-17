CREATE TABLE "gmail_connections" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"credential_reference" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"provider_account_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_id" text NOT NULL,
	CONSTRAINT "gmail_connections_grant_before_revocation_check" CHECK ("gmail_connections"."revoked_at" is null or "gmail_connections"."granted_at" <= "gmail_connections"."revoked_at")
);
--> statement-breakpoint
CREATE TABLE "gmail_send_attempts" (
	"action_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"outcome" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gmail_send_attempts_outcome_check" CHECK ("gmail_send_attempts"."outcome" in ('pending', 'applied', 'notApplied', 'ambiguous'))
);
--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_send_attempts" ADD CONSTRAINT "gmail_send_attempts_connection_id_gmail_connections_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gmail_connections"("connection_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_connections_user_unique" ON "gmail_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_connections_provider_account_unique" ON "gmail_connections" USING btree ("provider_account_id");--> statement-breakpoint
CREATE INDEX "gmail_connections_user_revoked_index" ON "gmail_connections" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "gmail_send_attempts_connection_index" ON "gmail_send_attempts" USING btree ("connection_id");