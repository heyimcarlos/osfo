import { Workflow } from "alchemy/Cloudflare";

import type { QualificationCohortScrubPartitionWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** One exact, sequential, maximum-32-page qualification cohort scrub partition. */
export const QualificationCohortScrubPartitionWorkflow =
  Workflow<QualificationCohortScrubPartitionWorkflowPayload>(
    "QualificationCohortScrubPartitionWorkflow",
    { className: "QualificationCohortScrubPartitionWorkflow" },
  );
