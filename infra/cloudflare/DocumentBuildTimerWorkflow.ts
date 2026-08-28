import { Workflow } from "alchemy/Cloudflare";

import type { DocumentBuild } from "../../apps/worker/src/services/document-build";

/** Parent-derived durable timer for Document Build preview and deadline guards. */
export const DocumentBuildTimerWorkflow = Workflow<DocumentBuild.WorkflowPayload>(
  "DocumentBuildTimerWorkflow",
  { className: "DocumentBuildTimerWorkflow" },
);
