import { Workflow } from "alchemy/Cloudflare";

import type { ResearchReport } from "../../apps/worker/src/services/research-report";

/** Dedicated Cloudflare Workflow for one governed Research Report execution. */
export const ResearchReportWorkflow = Workflow<ResearchReport.WorkflowPayload>(
  "ResearchReportWorkflow",
  { className: "ResearchReportWorkflow" },
);
