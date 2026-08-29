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
  readonly dimension: string;
  readonly executionId: string;
  readonly index: number;
  readonly inputs: ReadonlyArray<{
    readonly artifactId: string;
    readonly checksum: string;
  }>;
  readonly level: number;
  readonly outputArtifactPrefix: string;
  readonly outputRunId: string;
  readonly planChecksum: string;
}
