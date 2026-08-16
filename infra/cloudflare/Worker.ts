import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";

import { Hyperdrive } from "./Db";
import { ExecutionUnitWorkflow } from "./ExecutionUnitWorkflow";

/** Cloudflare Worker and execution-unit bindings for one Osfo runtime stage. */
export default Cloudflare.Worker(
  "Api",
  Stack.useSync(({ stage }) => {
    const workerOptions = {
      compatibility: {
        // Alchemy 2.0.0-beta.72 bundles a local Workerd runtime that supports dates through 2026-07-11.
        date: stage === "production" ? "2026-08-12" : "2026-07-11",
        flags: ["nodejs_compat"],
      },
      env: {
        BETTER_AUTH_API_KEY: Config.redacted("BETTER_AUTH_API_KEY"),
        BETTER_AUTH_BASE_URL: Config.string("BETTER_AUTH_BASE_URL"),
        BETTER_AUTH_SECRET: Config.redacted("BETTER_AUTH_SECRET"),
        BETTER_AUTH_TRUSTED_ORIGINS: Config.string("BETTER_AUTH_TRUSTED_ORIGINS"),
        DB: Hyperdrive,
        EXECUTION_UNIT_WORKFLOW: ExecutionUnitWorkflow,
        OSFO_AGENT: Cloudflare.DurableObject("OsfoAgent", {
          className: "OsfoAgent",
        }),
        OSFO_STAGE: stage === "development" || stage === "production" ? stage : "preview",
        REGISTRATION_DIALOGUE: Cloudflare.DurableObject("RegistrationDialogue", {
          className: "RegistrationDialogue",
        }),
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
