import { Workflow } from "alchemy/Cloudflare";

import type { ResearchReportWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Parent-derived timer host for Research Report milestones and the hard deadline. */
export const ResearchReportTimerWorkflow = Workflow<ResearchReportWorkflowPayload>(
  "ResearchReportTimerWorkflow",
  { className: "ResearchReportTimerWorkflow" },
);
