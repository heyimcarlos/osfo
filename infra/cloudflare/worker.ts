import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import type { OsfoStage } from "@osfo/worker/env";
import type { WorkerObservability } from "alchemy/Cloudflare";
import type { dataResources } from "./data";
import type { workflowResources } from "./workflows";

/** Provision the Osfo Worker and its execution-unit bindings. */
export const workerResources = (
  stage: OsfoStage,
  data: Effect.Success<ReturnType<typeof dataResources>>,
  executionUnitWorkflow: ReturnType<typeof workflowResources>["executionUnit"],
  observability: WorkerObservability,
) =>
  Effect.gen(function* () {
    const compatibilityFlags: Array<"nodejs_compat"> = ["nodejs_compat"];
    const osfoAgent = Cloudflare.DurableObject("OsfoAgent", {
      className: "OsfoAgent",
    });
    const registrationDialogue = Cloudflare.DurableObject("RegistrationDialogue", {
      className: "RegistrationDialogue",
    });
    const workerOptions = {
      compatibility: {
        date: "2026-08-12",
        flags: compatibilityFlags,
      },
      env: {
        BETTER_AUTH_API_KEY: Config.redacted("BETTER_AUTH_API_KEY"),
        BETTER_AUTH_BASE_URL: Config.string("BETTER_AUTH_BASE_URL"),
        BETTER_AUTH_SECRET: Config.redacted("BETTER_AUTH_SECRET"),
        BETTER_AUTH_TRUSTED_ORIGINS: Config.string("BETTER_AUTH_TRUSTED_ORIGINS"),
        DB: data.hyperdrive,
        EXECUTION_UNIT_WORKFLOW: executionUnitWorkflow,
        OSFO_AGENT: osfoAgent,
        OSFO_STAGE: stage,
        REGISTRATION_DIALOGUE: registrationDialogue,
        TWILIO_ACCOUNT_SID: Config.string("TWILIO_ACCOUNT_SID"),
        TWILIO_AUTH_TOKEN: Config.redacted("TWILIO_AUTH_TOKEN"),
        TWILIO_VERIFY_SERVICE_SID: Config.string("TWILIO_VERIFY_SERVICE_SID"),
      },
      main: "./apps/worker/src/worker.ts",
      observability,
    };
    const worker = yield* Cloudflare.Worker(
      "Osfo",
      stage === "production" ? { ...workerOptions, domain: "api.osfo.ai" } : workerOptions,
    );

    return { worker };
  });
