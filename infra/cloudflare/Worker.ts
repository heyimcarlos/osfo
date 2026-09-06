import { Container, DurableObject, Worker, Workers } from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Config, Effect } from "effect";

import { DatabaseHyperdrive } from "./Db";
import { DocumentBuildTimerWorkflow } from "./DocumentBuildTimerWorkflow";
import { DocumentBuildWorkflow } from "./DocumentBuildWorkflow";
import { ResearchReportWorkflow } from "./ResearchReportWorkflow";
import { ResearchReportTimerWorkflow } from "./ResearchReportTimerWorkflow";
import { ScheduledEmailWorkflow } from "./ScheduledEmailWorkflow";
import { Files } from "./Files";
import { Artifacts } from "./Artifacts";
import { browserHostBindings, composioApiKeyConfig } from "./WorkerConfig";

/** Cloudflare Worker and execution-unit bindings for one Osfo runtime stage. */
const worker = Worker(
  "Api",
  Stack.useSync(({ stage }) => {
    const authBaseUrl =
      stage === "production" ? "https://api.osfo.ai" : Config.string("BETTER_AUTH_BASE_URL");
    const authTrustedOrigins =
      stage === "production"
        ? JSON.stringify(["https://osfo.ai"])
        : Config.string("BETTER_AUTH_TRUSTED_ORIGINS");
    const workerOptions = {
      compatibility: {
        // Alchemy 2.0.0-beta.72 bundles a local Workerd runtime that supports dates through 2026-07-11.
        date: stage === "production" ? "2026-08-12" : "2026-07-11",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      env: {
        ...browserHostBindings(stage),
        AI: Workers.AI(),
        ARTIFACTS: Artifacts,
        BETTER_AUTH_API_KEY: Config.redacted("BETTER_AUTH_API_KEY"),
        BETTER_AUTH_BASE_URL: authBaseUrl,
        BETTER_AUTH_SECRET: Config.redacted("BETTER_AUTH_SECRET"),
        BETTER_AUTH_TRUSTED_ORIGINS: authTrustedOrigins,
        COMPOSIO_API_KEY: composioApiKeyConfig(stage),
        COMPANY_CONVERSATION_PUBLIC_SEARCH_DAILY_LIMIT: Config.string(
          "COMPANY_CONVERSATION_PUBLIC_SEARCH_DAILY_LIMIT",
        ).pipe(Config.withDefault("")),
        PUBLIC_WEB_SEARCH_GATEWAY_ID: Config.string("PUBLIC_WEB_SEARCH_GATEWAY_ID").pipe(Config.withDefault("")),
        DB: DatabaseHyperdrive,
        DOCUMENT_SANDBOX: Container("DocumentSandbox", {
          className: "Sandbox",
          context: "./apps/worker/document-sandbox",
          instanceType: "lite",
        }),
        DOCUMENT_BUILD_TIMER_WORKFLOW: DocumentBuildTimerWorkflow,
        DOCUMENT_BUILD_WORKFLOW: DocumentBuildWorkflow,
        RESEARCH_REPORT_WORKFLOW: ResearchReportWorkflow,
        RESEARCH_REPORT_TIMER_WORKFLOW: ResearchReportTimerWorkflow,
        SCHEDULED_EMAIL_WORKFLOW: ScheduledEmailWorkflow,
        FILES: Files,
        OSFO_DIRECTORY: DurableObject("OsfoDirectory", {
          className: "OsfoDirectory",
        }),
        OSFO_STAGE: stage === "development" || stage === "production" ? stage : "preview",
        SANDBOX_TRANSPORT: "rpc",
        STRIPE_ADVENTURER_PRICE_ID: Config.string("STRIPE_ADVENTURER_PRICE_ID"),
        STRIPE_ADVENTURER_PRODUCT_ID: Config.string("STRIPE_ADVENTURER_PRODUCT_ID"),
        STRIPE_PORTAL_CONFIGURATION_ID: Config.string("STRIPE_PORTAL_CONFIGURATION_ID"),
        STRIPE_SECRET_KEY: Config.redacted("STRIPE_SECRET_KEY"),
        STRIPE_WEBHOOK_SECRET: Config.redacted("STRIPE_WEBHOOK_SECRET"),
        SUPERMEMORY_API_KEY: Config.redacted("SUPERMEMORY_API_KEY"),
        TELEGRAM_ALLOWED_USER_IDS: Config.redacted("TELEGRAM_ALLOWED_USER_IDS"),
        TELEGRAM_BOT_TOKEN: Config.redacted("TELEGRAM_BOT_TOKEN"),
        TELEGRAM_BOT_USERNAME: Config.string("TELEGRAM_BOT_USERNAME"),
        TELEGRAM_WEBHOOK_SECRET_TOKEN: Config.redacted("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
        TWILIO_ACCOUNT_SID: Config.string("TWILIO_ACCOUNT_SID"),
        TWILIO_AUTH_TOKEN: Config.redacted("TWILIO_AUTH_TOKEN"),
        TWILIO_VERIFY_SERVICE_SID: Config.string("TWILIO_VERIFY_SERVICE_SID"),
        WHATSAPP_ACCESS_TOKEN: Config.redacted("WHATSAPP_ACCESS_TOKEN"),
        WHATSAPP_APP_SECRET: Config.redacted("WHATSAPP_APP_SECRET"),
        WHATSAPP_BOT_USERNAME: Config.string("WHATSAPP_BOT_USERNAME"),
        WHATSAPP_PHONE_NUMBER_ID: Config.string("WHATSAPP_PHONE_NUMBER_ID"),
        WHATSAPP_VERIFY_TOKEN: Config.redacted("WHATSAPP_VERIFY_TOKEN"),
        WHATSAPP_WAKEUP_TEMPLATE_APPROVAL: Config.string("WHATSAPP_WAKEUP_TEMPLATE_APPROVAL").pipe(
          Config.withDefault(""),
        ),
        WHATSAPP_WAKEUP_TEMPLATE_NAME: Config.string("WHATSAPP_WAKEUP_TEMPLATE_NAME").pipe(
          Config.withDefault(""),
        ),
        WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION: Config.string(
          "WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION",
        ).pipe(Config.withDefault("")),
      },
      crons: ["* * * * *", "0 * * * *"],
      main: "./apps/worker/src/worker.ts",
      observability: {
        enabled: true,
        logs: {
          enabled: true,
          headSamplingRate: 1,
          invocationLogs: true,
        },
        traces: {
          enabled: true,
          headSamplingRate: 1,
        },
      },
    };

    return stage === "production" ? { ...workerOptions, domain: "api.osfo.ai" } : workerOptions;
  }),
);

// SAFETY: Wrangler 4.127 and the Cloudflare Workers API recognize this
// zero-config binding shape. Alchemy 2.0.0-beta.72 does not yet expose it in
// WorkerBinding, so the owning infrastructure adapter contains the temporary
// type gap while still publishing the production binding.
// oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion
const webSearchBinding = {
  name: "WEBSEARCH",
  type: "websearch",
} as unknown as Workers.WorkerBinding;

export default worker.pipe(
  Effect.tap((deployed) => deployed.bind`WEBSEARCH`({ bindings: [webSearchBinding] })),
);
