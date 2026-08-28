import { Workflow } from "alchemy/Cloudflare";

import type { DocumentBuildWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Parent-derived durable timer for Document Build preview and deadline guards. */
export const DocumentBuildTimerWorkflow = Workflow<DocumentBuildWorkflowPayload>(
  "DocumentBuildTimerWorkflow",
  { className: "DocumentBuildTimerWorkflow" },
);
