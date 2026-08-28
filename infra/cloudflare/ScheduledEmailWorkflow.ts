import { Workflow } from "alchemy/Cloudflare";

import type { ScheduledEmailWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Dedicated Cloudflare Workflow for one exact future Gmail effect. */
export const ScheduledEmailWorkflow = Workflow<ScheduledEmailWorkflowPayload>(
  "ScheduledEmailWorkflow",
  { className: "ScheduledEmailWorkflow" },
);
