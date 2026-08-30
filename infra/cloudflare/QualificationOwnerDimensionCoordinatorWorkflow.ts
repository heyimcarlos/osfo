import { Workflow } from "alchemy/Cloudflare";

import type { QualificationOwnerDimensionWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Long-lived private coordinator for every exact qualification sample dimension. */
export const QualificationOwnerDimensionCoordinatorWorkflow =
  Workflow<QualificationOwnerDimensionWorkflowPayload>(
    "QualificationOwnerDimensionCoordinatorWorkflow",
    { className: "QualificationOwnerDimensionCoordinatorWorkflow" },
  );
