import { Container, DurableObject, Worker, Workers } from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Config } from "effect";

import { DatabaseHyperdrive } from "./Db";
import { ExecutionUnitWorkflow } from "./ExecutionUnitWorkflow";
import { Files } from "./Files";
import { Artifacts } from "./Artifacts";

/** Cloudflare Worker and execution-unit bindings for one Osfo runtime stage. */
export default Worker(
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
        flags: ["nodejs_compat"],
      },
      env: {
        AI: Workers.AI(),
        ARTIFACTS: Artifacts,
        BETTER_AUTH_API_KEY: Config.redacted("BETTER_AUTH_API_KEY"),
        BETTER_AUTH_BASE_URL: authBaseUrl,
        BETTER_AUTH_SECRET: Config.redacted("BETTER_AUTH_SECRET"),
        BETTER_AUTH_TRUSTED_ORIGINS: authTrustedOrigins,
        DB: DatabaseHyperdrive,
        DOCUMENT_SANDBOX: Container("DocumentSandbox", {
          className: "Sandbox",
          context: "./apps/worker/document-sandbox",
          instanceType: "lite",
        }),
        EXECUTION_UNIT_WORKFLOW: ExecutionUnitWorkflow,
        FILES: Files,
        OSFO_DIRECTORY: DurableObject("OsfoDirectory", {
          className: "OsfoDirectory",
        }),
        OSFO_STAGE: stage === "development" || stage === "production" ? stage : "preview",
        STRIPE_ADVENTURER_PRICE_ID: Config.string("STRIPE_ADVENTURER_PRICE_ID"),
        STRIPE_ADVENTURER_PRODUCT_ID: Config.string("STRIPE_ADVENTURER_PRODUCT_ID"),
        STRIPE_PORTAL_CONFIGURATION_ID: Config.string("STRIPE_PORTAL_CONFIGURATION_ID"),
        STRIPE_SECRET_KEY: Config.redacted("STRIPE_SECRET_KEY"),
        STRIPE_WEBHOOK_SECRET: Config.redacted("STRIPE_WEBHOOK_SECRET"),
        REGISTRATION_DIALOGUE: DurableObject("RegistrationDialogue", {
          className: "RegistrationDialogue",
        }),
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
        WHATSAPP_PUBLIC_PHONE_NUMBER: Config.string("WHATSAPP_PUBLIC_PHONE_NUMBER"),
        WHATSAPP_VERIFY_TOKEN: Config.redacted("WHATSAPP_VERIFY_TOKEN"),
      },
      crons: ["0 * * * *"],
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
