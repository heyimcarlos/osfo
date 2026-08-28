import { Workflow } from "alchemy/Cloudflare";

import type { ResearchReport } from "../../apps/worker/src/services/research-report";

/** Parent-derived timer host for Research Report milestones and the hard deadline. */
export const ResearchReportTimerWorkflow = Workflow<ResearchReport.WorkflowPayload>(
  "ResearchReportTimerWorkflow",
  { className: "ResearchReportTimerWorkflow" },
);
