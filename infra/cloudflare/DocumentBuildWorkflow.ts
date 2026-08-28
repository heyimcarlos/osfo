import { Workflow } from "alchemy/Cloudflare";

import type { DocumentBuild } from "../../apps/worker/src/services/document-build";

/** Dedicated Cloudflare Workflow for one governed Document Build execution. */
export const DocumentBuildWorkflow = Workflow<DocumentBuild.WorkflowPayload>(
  "DocumentBuildWorkflow",
  { className: "DocumentBuildWorkflow" },
);
