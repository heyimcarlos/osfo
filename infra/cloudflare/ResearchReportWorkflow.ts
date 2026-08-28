import { Workflow } from "alchemy/Cloudflare";

import type { ResearchReportWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Dedicated Cloudflare Workflow for one governed Research Report execution. */
export const ResearchReportWorkflow = Workflow<ResearchReportWorkflowPayload>(
  "ResearchReportWorkflow",
  { className: "ResearchReportWorkflow" },
);
