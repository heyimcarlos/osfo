import { Workflow } from "alchemy/Cloudflare";

import type { DocumentBuildWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Dedicated Cloudflare Workflow for one governed Document Build execution. */
export const DocumentBuildWorkflow = Workflow<DocumentBuildWorkflowPayload>(
  "DocumentBuildWorkflow",
  { className: "DocumentBuildWorkflow" },
);
