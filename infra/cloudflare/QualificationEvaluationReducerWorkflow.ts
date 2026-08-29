import { Workflow } from "alchemy/Cloudflare";

import type { QualificationEvaluationReducerWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Resumable exact sorted-run reducer for one qualification sample dimension. */
export const QualificationEvaluationReducerWorkflow =
  Workflow<QualificationEvaluationReducerWorkflowPayload>(
    "QualificationEvaluationReducerWorkflow",
    {
      className: "QualificationEvaluationReducerWorkflow",
    },
  );
