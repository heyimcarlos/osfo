CREATE TABLE "account_deletion_actions" (
	"action_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"auth_session_id" text NOT NULL,
	"replay_session_cookie_hash" text NOT NULL,
	"presentation" text NOT NULL,
	"presentation_version" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"deletion_case_id" text,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletion_actions_identity_check" CHECK (length(btrim("account_deletion_actions"."action_id")) > 0 and length(btrim("account_deletion_actions"."user_id")) > 0 and length(btrim("account_deletion_actions"."auth_session_id")) > 0 and "account_deletion_actions"."replay_session_cookie_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "account_deletion_actions_presentation_check" CHECK (length(btrim("account_deletion_actions"."presentation")) > 0 and length(btrim("account_deletion_actions"."presentation_version")) > 0),
	CONSTRAINT "account_deletion_actions_lifecycle_check" CHECK ("account_deletion_actions"."expires_at" > "account_deletion_actions"."created_at"
        and ("account_deletion_actions"."consumed_at" is null or "account_deletion_actions"."consumed_at" >= "account_deletion_actions"."created_at")
        and ("account_deletion_actions"."invalidated_at" is null or "account_deletion_actions"."invalidated_at" >= "account_deletion_actions"."created_at")
        and ("account_deletion_actions"."consumed_at" is null or "account_deletion_actions"."invalidated_at" is null)
        and (("account_deletion_actions"."consumed_at" is null and "account_deletion_actions"."deletion_case_id" is null)
          or ("account_deletion_actions"."consumed_at" is not null and "account_deletion_actions"."deletion_case_id" is not null and length(btrim("account_deletion_actions"."deletion_case_id")) > 0)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_cases_identity_unique" ON "deletion_cases" USING btree ("deletion_case_id","user_id");--> statement-breakpoint
ALTER TABLE "account_deletion_actions" ADD CONSTRAINT "account_deletion_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_deletion_actions" ADD CONSTRAINT "account_deletion_actions_case_user_fk" FOREIGN KEY ("deletion_case_id","user_id") REFERENCES "public"."deletion_cases"("deletion_case_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_deletion_actions_user_index" ON "account_deletion_actions" USING btree ("user_id");
