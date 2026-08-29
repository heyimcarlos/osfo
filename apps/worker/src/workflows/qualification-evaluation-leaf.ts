import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Data, Schema } from "effect";

import {
  QualificationEvaluationLeafOutcome,
  runQualificationEvaluationLeaf,
  type QualificationEvaluationLeafBucket,
} from "../qualification/qualification-evaluation-leaf";
import { decodeFrozenQualificationExecution } from "../qualification/frozen-execution";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import { retainQualificationEvaluationArtifact } from "../qualification/qualification-evaluation-reducer";
import type { QualificationEvaluationLeafWorkflowPayload } from "../workflow-contracts";

/* oxlint-disable effecttsgo/async-function -- Cloudflare Workflow and R2 bindings are Promise-only durable host boundaries. */

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Immutable terminal result of one bounded leaf-evaluation Workflow. */
export const QualificationEvaluationLeafCompletion = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  leafInputArtifactId: Identity,
  leafInputChecksum: Identity,
  manifestChecksum: Identity,
  outcome: QualificationEvaluationLeafOutcome,
  partitionIndex: NonNegativeInteger,
  planChecksum: Identity,
  runId: Identity,
  version: Schema.Literal("qualification-evaluation-leaf-completion-v1"),
});

export class QualificationEvaluationLeafCompletionConflict extends Data.TaggedError(
  "QualificationEvaluationLeafCompletionConflict",
)<{ readonly message: string }> {}

interface QualificationEvaluationLeafWorkflowEnv {
  readonly ARTIFACTS: QualificationEvaluationLeafBucket;
}

export interface QualificationEvaluationLeafWorkflowStep {
  readonly do: <Value>(name: string, callback: () => Promise<Value>) => Promise<Value>;
}

export interface QualificationEvaluationLeafWorkflowPorts {
  readonly evaluate: typeof runQualificationEvaluationLeaf;
}

const productionPorts: QualificationEvaluationLeafWorkflowPorts = {
  evaluate: runQualificationEvaluationLeaf,
};

const completionArtifactId = (executionId: string, partitionIndex: number) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-leaf-completions/${partitionIndex.toString().padStart(8, "0")}.json`;

const completion = (
  payload: QualificationEvaluationLeafWorkflowPayload,
  outcome: QualificationEvaluationLeafOutcome,
): typeof QualificationEvaluationLeafCompletion.Type => {
  const content = {
    artifactId: completionArtifactId(payload.executionId, payload.partitionIndex),
    executionId: payload.executionId,
    leafInputArtifactId: payload.leafInputArtifactId,
    leafInputChecksum: payload.leafInputChecksum,
    manifestChecksum: payload.manifestChecksum,
    outcome,
    partitionIndex: payload.partitionIndex,
    planChecksum: payload.planChecksum,
    runId: payload.runId,
    version: "qualification-evaluation-leaf-completion-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

/** Evaluate and durably retain one bounded leaf without exposing corpus-sized Workflow state. */
export const runQualificationEvaluationLeafWorkflow = async (input: {
  readonly env: QualificationEvaluationLeafWorkflowEnv;
  readonly payload: QualificationEvaluationLeafWorkflowPayload;
  readonly ports?: QualificationEvaluationLeafWorkflowPorts;
  readonly step: QualificationEvaluationLeafWorkflowStep;
}): Promise<typeof QualificationEvaluationLeafCompletion.Type> => {
  const ports = input.ports ?? productionPorts;
  const rawOutcome = await input.step.do(
    `evaluate qualification leaf ${input.payload.partitionIndex}`,
    async () => {
      const retainedRequest = await input.env.ARTIFACTS.get(input.payload.requestArtifactId);
      if (retainedRequest === null) {
        return {
          artifactId: input.payload.requestArtifactId,
          code: "qualificationEvaluationOwnerRequestMissing" as const,
          source: null,
          status: "MISSING" as const,
        };
      }
      if (retainedRequest.customMetadata?.["osfo-kind"] !== "qualification-execution-v1") {
        return {
          artifactId: input.payload.requestArtifactId,
          code: "qualificationEvaluationOwnerRequestConflict" as const,
          source: null,
          status: "FAIL" as const,
        };
      }
      const frozen = decodeFrozenQualificationExecution(
        await retainedRequest.text(),
        input.payload,
      );
      if (frozen === null) {
        return {
          artifactId: input.payload.requestArtifactId,
          code: "qualificationEvaluationOwnerRequestConflict" as const,
          source: null,
          status: "FAIL" as const,
        };
      }
      let firstPartitionIndex = 0;
      const run = frozen.plan.runs.find((candidate) => {
        const runChunkCount = Math.ceil(candidate.arrivalCount / 256);
        const includesPartition =
          input.payload.partitionIndex >= firstPartitionIndex &&
          input.payload.partitionIndex < firstPartitionIndex + runChunkCount;
        firstPartitionIndex += runChunkCount;
        return includesPartition;
      });
      if (run === undefined || run.runId !== input.payload.runId) {
        return {
          artifactId: input.payload.requestArtifactId,
          code: "qualificationEvaluationOwnerRequestConflict" as const,
          source: null,
          status: "FAIL" as const,
        };
      }
      return ports.evaluate({
        bucket: input.env.ARTIFACTS,
        executionId: input.payload.executionId,
        leafInputArtifactId: input.payload.leafInputArtifactId,
        leafInputChecksum: input.payload.leafInputChecksum,
        manifest: frozen.manifest,
        partitionIndex: input.payload.partitionIndex,
        planChecksum: input.payload.planChecksum,
        run,
      });
    },
  );
  const outcome = Schema.decodeSync(QualificationEvaluationLeafOutcome)(rawOutcome);
  const retainedCompletion = completion(input.payload, outcome);
  return input.step.do(
    `retain qualification leaf completion ${input.payload.partitionIndex}`,
    async () => {
      const retained = await retainQualificationEvaluationArtifact({
        artifactId: retainedCompletion.artifactId,
        bucket: input.env.ARTIFACTS,
        checksum: retainedCompletion.checksum,
        encoded: canonicalQualificationJson(retainedCompletion),
        executionId: input.payload.executionId,
        kind: "qualification-evaluation-leaf-completion-v1",
        metadata: {
          "osfo-leaf-input-checksum": input.payload.leafInputChecksum,
          "osfo-outcome": outcome.status,
          "osfo-partition-index": String(input.payload.partitionIndex),
          "osfo-record-count": outcome.status === "COMPLETE" ? outcome.receipt.rootCount : "0",
          "osfo-run-id": input.payload.runId,
        },
        planChecksum: input.payload.planChecksum,
      });
      if (retained === "CONFLICT") {
        throw new QualificationEvaluationLeafCompletionConflict({
          message: "Retained qualification leaf completion conflicts",
        });
      }
      return retainedCompletion;
    },
  );
};

/** Durable bounded leaf evaluator. Reducer fan-out is owned by a later coordinator phase. */
export class QualificationEvaluationLeafWorkflow extends WorkflowEntrypoint<
  QualificationEvaluationLeafWorkflowEnv,
  QualificationEvaluationLeafWorkflowPayload
> {
  override run(
    event: Readonly<WorkflowEvent<QualificationEvaluationLeafWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<typeof QualificationEvaluationLeafCompletion.Type> {
    return runQualificationEvaluationLeafWorkflow({ env: this.env, payload: event.payload, step });
  }
}
