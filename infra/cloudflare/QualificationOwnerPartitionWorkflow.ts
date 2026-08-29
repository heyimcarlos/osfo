import { Workflow } from "alchemy/Cloudflare";

import type { QualificationOwnerPartitionWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** One arrival-chunk execution and source-collection partition. */
export const QualificationOwnerPartitionWorkflow =
  Workflow<QualificationOwnerPartitionWorkflowPayload>("QualificationOwnerPartitionWorkflow", {
    className: "QualificationOwnerPartitionWorkflow",
  });
