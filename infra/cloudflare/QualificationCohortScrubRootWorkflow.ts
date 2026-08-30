import { Workflow } from "alchemy/Cloudflare";

import type { QualificationCohortScrubRootWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Strict-order coordinator for every qualification cohort scrub page partition. */
export const QualificationCohortScrubRootWorkflow =
  Workflow<QualificationCohortScrubRootWorkflowPayload>("QualificationCohortScrubRootWorkflow", {
    className: "QualificationCohortScrubRootWorkflow",
  });
