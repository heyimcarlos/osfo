import { Workflow } from "alchemy/Cloudflare";

import type { QualificationEvaluationCorrectnessReducerWorkflowPayload } from "@osfo/worker/workflow-contracts";

/** Bounded exact correctness/root reducer for one ordered child range. */
export const QualificationEvaluationCorrectnessReducerWorkflow =
  Workflow<QualificationEvaluationCorrectnessReducerWorkflowPayload>(
    "QualificationEvaluationCorrectnessReducerWorkflow",
    { className: "QualificationEvaluationCorrectnessReducerWorkflow" },
  );
