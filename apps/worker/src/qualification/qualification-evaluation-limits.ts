import {
  qualificationEvaluationLeafMaximumFindingShardCount,
  qualificationEvaluationLeafRootLimit,
} from "./qualification-evaluation-leaf";
import {
  qualificationEvaluationMaximumDimensionContinuations,
  qualificationEvaluationReducerFanIn,
  qualificationEvaluationSampleShardLimit,
} from "./qualification-evaluation-reducer";

/** Explicit Cloudflare limit shared by the private Worker that hosts qualification Workflows. */
export const qualificationWorkflowSubrequestLimit = 250_000;

export const qualificationWorkflowSubrequestHardLimit = {
  maximum: qualificationWorkflowSubrequestLimit,
  name: "qualificationWorkflowSubrequests",
  unit: "requests",
} as const;

const immutableWriteSubrequests = 2;
const terminalArtifactSubrequests = 6;
const rootChainFragmentation = qualificationEvaluationReducerFanIn - 1;
export const qualificationCorrectnessRootVerificationPageSize = 64;

/** Worst case includes commit-uncertain readback for every immutable output and cursor write. */
export const qualificationSortedReducerMaximumSubrequests =
  qualificationEvaluationReducerFanIn +
  qualificationEvaluationMaximumDimensionContinuations *
    (qualificationEvaluationReducerFanIn + immutableWriteSubrequests * 2) +
  1 +
  immutableWriteSubrequests;

const qualificationCorrectnessLeafMaximumSubrequests =
  qualificationEvaluationReducerFanIn * (3 + qualificationEvaluationLeafMaximumFindingShardCount) +
  qualificationEvaluationReducerFanIn +
  Math.ceil(
    (qualificationEvaluationReducerFanIn * qualificationEvaluationLeafRootLimit) /
      qualificationEvaluationSampleShardLimit,
  ) *
    (qualificationEvaluationReducerFanIn + immutableWriteSubrequests) +
  terminalArtifactSubrequests;

const qualificationCorrectnessHigherMaximumSubrequests =
  qualificationEvaluationReducerFanIn * 3 +
  qualificationEvaluationMaximumDimensionContinuations +
  rootChainFragmentation +
  qualificationEvaluationMaximumDimensionContinuations *
    (qualificationEvaluationReducerFanIn + immutableWriteSubrequests) +
  terminalArtifactSubrequests;

export const qualificationCorrectnessReducerMaximumSubrequests = Math.max(
  qualificationCorrectnessLeafMaximumSubrequests,
  qualificationCorrectnessHigherMaximumSubrequests,
);

export const qualificationReducerRetrySubrequestAllowance =
  qualificationWorkflowSubrequestLimit -
  Math.max(
    qualificationSortedReducerMaximumSubrequests,
    qualificationCorrectnessReducerMaximumSubrequests,
  );

/** Both reducer Workflows stay below Cloudflare's default 10,000-step ceiling. */
export const qualificationCorrectnessReducerMaximumSteps =
  qualificationEvaluationReducerFanIn +
  Math.ceil(
    qualificationEvaluationMaximumDimensionContinuations /
      qualificationCorrectnessRootVerificationPageSize,
  ) +
  rootChainFragmentation +
  qualificationEvaluationMaximumDimensionContinuations +
  3;
