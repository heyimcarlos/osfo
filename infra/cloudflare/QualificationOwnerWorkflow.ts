import { Workflow } from "alchemy/Cloudflare";

import type { QualificationOwnerWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Durable bounded qualification owner execution. */
export const QualificationOwnerWorkflow = Workflow<QualificationOwnerWorkflowPayload>(
  "QualificationOwnerWorkflow",
  { className: "QualificationOwnerWorkflow" },
);
