import * as Cloudflare from "alchemy/Cloudflare";

/** Cloudflare Workflow binding that executes one durable Osfo operation. */
export const ExecutionUnitWorkflow = Cloudflare.Workflow<null>("ExecutionUnitWorkflow", {
  className: "ExecutionUnitWorkflow",
});
