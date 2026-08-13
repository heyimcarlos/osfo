import * as Cloudflare from "alchemy/Cloudflare";

import type { OsfoStage } from "@osfo/worker/env";

/** Define the stage-local Workflow resource group. */
export const workflowResources = (stage: OsfoStage) => ({
  executionUnit: Cloudflare.Workflow<null>("ExecutionUnitWorkflow", {
    className: "ExecutionUnitWorkflow",
  }),
  stage,
});
