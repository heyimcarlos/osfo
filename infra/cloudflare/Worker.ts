import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";

import { Hyperdrive } from "./Db";
import { ExecutionUnitWorkflow } from "./ExecutionUnitWorkflow";
import { Files } from "./Files";
import { Artifacts } from "./Artifacts";

/** Cloudflare Worker and execution-unit bindings for one Osfo runtime stage. */
export default Cloudflare.Worker(
  "Api",
  Stack.useSync(({ stage }) => {
    const telegramEnv =
      stage === "production"
        ? {}
        : {
            TELEGRAM_ALLOWED_USER_IDS: Config.redacted("TELEGRAM_ALLOWED_USER_IDS").pipe(
              Config.withDefault(Redacted.make("")),
            ),
            TELEGRAM_BOT_TOKEN: Config.redacted("TELEGRAM_BOT_TOKEN").pipe(
              Config.withDefault(Redacted.make("")),
            ),
            TELEGRAM_BOT_USERNAME: Config.string("TELEGRAM_BOT_USERNAME").pipe(
              Config.withDefault(""),
            ),
            TELEGRAM_WEBHOOK_SECRET_TOKEN: Config.redacted("TELEGRAM_WEBHOOK_SECRET_TOKEN").pipe(
              Config.withDefault(Redacted.make("")),
            ),
          };
    const workerOptions = {
      compatibility: {
        // Alchemy 2.0.0-beta.72 bundles a local Workerd runtime that supports dates through 2026-07-11.
        date: stage === "production" ? "2026-08-12" : "2026-07-11",
        flags: ["nodejs_compat"],
      },
      env: {
        ARTIFACTS: Artifacts,
        BETTER_AUTH_API_KEY: Config.redacted("BETTER_AUTH_API_KEY"),
        BETTER_AUTH_BASE_URL: Config.string("BETTER_AUTH_BASE_URL"),
        BETTER_AUTH_SECRET: Config.redacted("BETTER_AUTH_SECRET"),
        BETTER_AUTH_TRUSTED_ORIGINS: Config.string("BETTER_AUTH_TRUSTED_ORIGINS"),
        GOOGLE_CLIENT_ID: Config.string("GOOGLE_CLIENT_ID"),
        GOOGLE_CLIENT_SECRET: Config.redacted("GOOGLE_CLIENT_SECRET"),
        DB: Hyperdrive,
        DOCUMENT_SANDBOX: Cloudflare.Container("DocumentSandbox", {
          className: "Sandbox",
          context: "./apps/worker/document-sandbox",
          instanceType: "lite",
        }),
        EXECUTION_UNIT_WORKFLOW: ExecutionUnitWorkflow,
        FILES: Files,
        META_APP_SECRET: Config.redacted("META_APP_SECRET"),
        META_WEBHOOK_VERIFY_TOKEN: Config.redacted("META_WEBHOOK_VERIFY_TOKEN"),
        OSFO_AGENT: Cloudflare.DurableObject("OsfoAgent", {
          className: "OsfoAgent",
        }),
        OSFO_STAGE: stage === "development" || stage === "production" ? stage : "preview",
        STRIPE_ADVENTURER_PRICE_ID: Config.string("STRIPE_ADVENTURER_PRICE_ID"),
        STRIPE_ADVENTURER_PRODUCT_ID: Config.string("STRIPE_ADVENTURER_PRODUCT_ID"),
        STRIPE_PORTAL_CONFIGURATION_ID: Config.string("STRIPE_PORTAL_CONFIGURATION_ID"),
        STRIPE_SECRET_KEY: Config.redacted("STRIPE_SECRET_KEY"),
        STRIPE_WEBHOOK_SECRET: Config.redacted("STRIPE_WEBHOOK_SECRET"),
        REGISTRATION_DIALOGUE: Cloudflare.DurableObject("RegistrationDialogue", {
          className: "RegistrationDialogue",
        }),
        ...telegramEnv,
        TWILIO_ACCOUNT_SID: Config.string("TWILIO_ACCOUNT_SID"),
        TWILIO_AUTH_TOKEN: Config.redacted("TWILIO_AUTH_TOKEN"),
        TWILIO_VERIFY_SERVICE_SID: Config.string("TWILIO_VERIFY_SERVICE_SID"),
        WHATSAPP_PHONE_NUMBER: Config.string("WHATSAPP_PHONE_NUMBER"),
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
