import { Workflow } from "alchemy/Cloudflare";

/** Cloudflare Workflow binding that executes one durable Osfo operation. */
export const ExecutionUnitWorkflow = Workflow<null>("ExecutionUnitWorkflow", {
  className: "ExecutionUnitWorkflow",
});
