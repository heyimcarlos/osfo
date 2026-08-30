import type { DocumentBuild } from "./services/document-build";
import type { ResearchReport } from "./services/research-report";
import type { ScheduledEmail } from "./services/scheduled-email";

/** Public infrastructure contract for the Document Build Workflow binding. */
export type DocumentBuildWorkflowPayload = DocumentBuild.WorkflowPayload;

/** Public infrastructure contract for the Research Report Workflow binding. */
export type ResearchReportWorkflowPayload = ResearchReport.WorkflowPayload;

/** Public infrastructure contract for the Scheduled Email Workflow binding. */
export type ScheduledEmailWorkflowPayload = ScheduledEmail.WorkflowPayload;

/** Compact immutable request passed to the bounded qualification-owner Workflow. */
export interface QualificationOwnerWorkflowPayload {
  readonly executionId: string;
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly requestArtifactChecksum: string;
  readonly requestArtifactId: string;
}

/** One bounded child of a frozen qualification owner execution. */
export interface QualificationOwnerPartitionWorkflowPayload extends QualificationOwnerWorkflowPayload {
  readonly chunks: ReadonlyArray<{
    readonly chunkIndex: number;
    readonly firstOfferedAtEpochMs: number;
    readonly runId: string;
    readonly streamChunkIndex: number;
  }>;
  readonly firstStreamChunkIndex: number;
  readonly lastStreamChunkIndex: number;
  readonly partitionIndex: number;
  readonly sourceVersion: string;
}

/** One resumable bounded exact-order merge for a qualification sample dimension. */
export interface QualificationEvaluationReducerWorkflowPayload {
  readonly denominatorChainDigest: string;
  readonly denominatorCount: number;
  readonly dimension: string;
  readonly executionId: string;
  readonly firstPartitionIndex: number;
  readonly index: number;
  readonly inputReceiptChainDigest: string;
  readonly inputs: ReadonlyArray<{
    readonly artifactId: string;
    readonly checksum: string;
  }>;
  readonly level: number;
  readonly lastPartitionIndex: number;
  readonly missingRootCount: number;
  readonly outputArtifactPrefix: string;
  readonly outputRunId: string;
  readonly planChecksum: string;
  readonly valueType: "identity" | "latencyMs";
}

/** One bounded correctness/root reduction over an exact ordered child range. */
export interface QualificationEvaluationCorrectnessReducerWorkflowPayload {
  readonly acceptedCount: number;
  readonly executionId: string;
  readonly firstPartitionIndex: number;
  readonly index: number;
  readonly inputKind: "correctness" | "leafCompletion";
  readonly inputReceiptChainDigest: string;
  readonly inputs: ReadonlyArray<{
    readonly artifactId: string;
    readonly checksum: string;
  }>;
  readonly lastPartitionIndex: number;
  readonly level: number;
  readonly outputArtifactPrefix: string;
  readonly planChecksum: string;
  readonly rootCount: number;
}

/** One bounded, independently replayable authority-leaf evaluation. */
export interface QualificationEvaluationLeafWorkflowPayload {
  readonly executionId: string;
  readonly leafInputArtifactId: string;
  readonly leafInputChecksum: string;
  readonly manifestChecksum: string;
  readonly partitionIndex: number;
  readonly planChecksum: string;
  readonly requestArtifactChecksum: string;
  readonly requestArtifactId: string;
  readonly runId: string;
}

/** Compact authority passed to the bounded per-dimension forest coordinator. */
export interface QualificationOwnerDimensionWorkflowPayload extends QualificationOwnerWorkflowPayload {
  readonly correctnessArtifactId: string;
  readonly correctnessChecksum: string;
  readonly correctnessLevel: number;
  readonly leafCompletionCount: number;
  readonly leafCompletionPageCount: number;
  readonly leafCompletionTerminalPageChecksum: string;
}
