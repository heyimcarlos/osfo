import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import type { OsfoStage } from "@osfo/worker/env";
import type { WorkerObservability } from "alchemy/Cloudflare";
import type { workflowResources } from "./workflows";

/** Provision the Osfo Worker and its execution-unit bindings. */
export const workerResources = (
  stage: OsfoStage,
  executionUnitWorkflow: ReturnType<typeof workflowResources>["executionUnit"],
  observability: WorkerObservability,
) =>
  Effect.gen(function* () {
    const osfoAgent = Cloudflare.DurableObject("OsfoAgent", {
      className: "OsfoAgent",
    });
    const registrationDialogue = Cloudflare.DurableObject("RegistrationDialogue", {
      className: "RegistrationDialogue",
    });
    const worker = yield* Cloudflare.Worker("Osfo", {
      compatibility: {
        date: "2026-08-12",
        flags: ["nodejs_compat"],
      },
      env: {
        EXECUTION_UNIT_WORKFLOW: executionUnitWorkflow,
        OSFO_AGENT: osfoAgent,
        OSFO_STAGE: stage,
        REGISTRATION_DIALOGUE: registrationDialogue,
      },
      main: "./apps/worker/src/worker.ts",
      observability,
    });

    return { worker };
  });
