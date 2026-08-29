import { Workflow } from "alchemy/Cloudflare";

import type { QualificationEvaluationLeafWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Independently replayable bounded authority-leaf evaluator. */
export const QualificationEvaluationLeafWorkflow =
  Workflow<QualificationEvaluationLeafWorkflowPayload>("QualificationEvaluationLeafWorkflow", {
    className: "QualificationEvaluationLeafWorkflow",
  });
