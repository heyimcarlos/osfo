import { WorkerEntrypoint, type Worker } from "alchemy/Cloudflare";
import { Effect } from "effect";

import { qualificationWorkflowSubrequestLimit } from "@osfo/worker/qualification-limits";

import { Artifacts } from "./Artifacts";
import { QualificationOwnerWorkflow } from "./QualificationOwnerWorkflow";
import { QualificationOwnerPartitionWorkflow } from "./QualificationOwnerPartitionWorkflow";
import { QualificationOwnerDimensionCoordinatorWorkflow } from "./QualificationOwnerDimensionCoordinatorWorkflow";
import { QualificationEvaluationCorrectnessReducerWorkflow } from "./QualificationEvaluationCorrectnessReducerWorkflow";
import { QualificationEvaluationReducerWorkflow } from "./QualificationEvaluationReducerWorkflow";
import { QualificationEvaluationLeafWorkflow } from "./QualificationEvaluationLeafWorkflow";
import { ApiWorker, QualificationOwnerWorker } from "./WorkerBindings";

// SAFETY: Alchemy resource tags are the supported representation for circular
// service bindings (its own circular Worker test passes tags directly). The
// named-entrypoint helper's older beta.72 signature accepts only a resolved
// Worker even though its provider handles the same tag at reconciliation.
const apiWorkerReference: unknown = ApiWorker;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: apiWorkerReference is the ApiWorker resource tag accepted by Alchemy's binding reconciler.
const qualificationProductAuthority = WorkerEntrypoint(apiWorkerReference as Worker, {
  entrypoint: "QualificationProductAuthority",
});

/** Private, stage-scoped owner for bounded qualification execution artifacts. */
export const QualificationOwnerLayer = QualificationOwnerWorker.make(
  {
    compatibility: {
      date: "2026-08-12",
      flags: ["nodejs_compat"],
    },
    env: {
      ARTIFACTS: Artifacts,
      PRODUCT_AUTHORITY: qualificationProductAuthority,
      QUALIFICATION_EVALUATION_CORRECTNESS_REDUCER_WORKFLOW:
        QualificationEvaluationCorrectnessReducerWorkflow,
      QUALIFICATION_EVALUATION_LEAF_WORKFLOW: QualificationEvaluationLeafWorkflow,
      QUALIFICATION_EVALUATION_REDUCER_WORKFLOW: QualificationEvaluationReducerWorkflow,
      QUALIFICATION_OWNER_PARTITION_WORKFLOW: QualificationOwnerPartitionWorkflow,
      QUALIFICATION_OWNER_DIMENSION_COORDINATOR_WORKFLOW:
        QualificationOwnerDimensionCoordinatorWorkflow,
      QUALIFICATION_OWNER_WORKFLOW: QualificationOwnerWorkflow,
    },
    limits: { subrequests: qualificationWorkflowSubrequestLimit },
    main: "./apps/worker/src/qualification-owner-worker.ts",
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 1, invocationLogs: true },
      traces: { enabled: true, headSamplingRate: 1 },
    },
  },
  Effect.succeed({}),
);
