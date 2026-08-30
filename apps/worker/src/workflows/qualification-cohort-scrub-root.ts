/* oxlint-disable effecttsgo/async-function -- Cloudflare Workflow, Durable Object RPC, and Hyperdrive are Promise-native host boundaries. */
import { createDb } from "@osfo/db";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect } from "effect";
import postgres from "postgres";

import type { QualificationCohortArtifactAuthority } from "../qualification-cohort-artifact-authority";
import {
  fenceQualificationCohortArtifacts,
  inspectQualificationCohortArtifacts,
} from "../integrations/cloudflare/qualification-cohort-artifacts";
import { makeQualificationCohortScrubAuthority } from "../integrations/postgres/qualification-cohort-scrub";
import { decodeQualificationCohortScrubRootWorkflowPayload } from "../qualification/cohort-scrub-root";
import { qualificationCohortScrubPartitionInstanceId } from "../qualification/cohort-scrub-partition";
import type {
  QualificationCohortScrubPartitionWorkflowPayload,
  QualificationCohortScrubRootWorkflowPayload,
} from "../workflow-contracts";
import {
  createOrReconcileQualificationScrubPartition,
  qualificationCohortScrubChildSnapshot,
  QualificationCohortScrubRootTerminal,
  runQualificationCohortScrubRoot,
  type QualificationCohortScrubRootPorts,
  type QualificationCohortScrubRootResult,
} from "./qualification-cohort-scrub-root-runtime";

interface QualificationCohortScrubRootEnv {
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly QUALIFICATION_COHORT_ARTIFACT_AUTHORITY: DurableObjectNamespace<QualificationCohortArtifactAuthority>;
  readonly QUALIFICATION_COHORT_SCRUB_PARTITION_WORKFLOW: Workflow<QualificationCohortScrubPartitionWorkflowPayload>;
}

const withDatabase = async <Value>(
  env: QualificationCohortScrubRootEnv,
  evaluate: (authority: ReturnType<typeof makeQualificationCohortScrubAuthority>) => Promise<Value>,
): Promise<Value> => {
  const client = postgres(env.DB.connectionString, { fetch_types: false, max: 1, prepare: true });
  try {
    return await evaluate(makeQualificationCohortScrubAuthority(createDb(client)));
  } finally {
    await client.end();
  }
};

const makePorts = (
  env: QualificationCohortScrubRootEnv,
  payload: QualificationCohortScrubRootWorkflowPayload,
): QualificationCohortScrubRootPorts => ({
  fence: () =>
    Effect.runPromise(
      fenceQualificationCohortArtifacts(
        env.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY,
        payload.executionId,
      ),
    ),
  inspectArtifacts: () =>
    Effect.runPromise(
      inspectQualificationCohortArtifacts(
        env.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY,
        payload.executionId,
      ),
    ),
  inspectChild: async (child) => {
    const id = childInstanceId(child);
    const instance = await env.QUALIFICATION_COHORT_SCRUB_PARTITION_WORKFLOW.get(id);
    return await qualificationCohortScrubChildSnapshot(instance, id);
  },
  inspectPartitionCompletion: (child) =>
    withDatabase(env, (authority) =>
      Effect.runPromise(authority.inspectScrubPartitionCompletion(payload, child.partitionIndex)),
    ),
  inspectTopology: () =>
    withDatabase(env, (authority) => Effect.runPromise(authority.inspectScrubRoot(payload))),
  launchChild: (child) =>
    createOrReconcileQualificationScrubPartition({
      create: (options) => env.QUALIFICATION_COHORT_SCRUB_PARTITION_WORKFLOW.create(options),
      get: (id) => env.QUALIFICATION_COHORT_SCRUB_PARTITION_WORKFLOW.get(id),
      id: childInstanceId(child),
      params: child,
    }),
});

const childInstanceId = (child: QualificationCohortScrubPartitionWorkflowPayload) =>
  qualificationCohortScrubPartitionInstanceId(child.executionId, child.partitionIndex);

/** Coordinates exact-order scrub pages only. Final root artifact deletion remains a later authority. */
export class QualificationCohortScrubRootWorkflow extends WorkflowEntrypoint<
  QualificationCohortScrubRootEnv,
  QualificationCohortScrubRootWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<QualificationCohortScrubRootWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<QualificationCohortScrubRootResult> {
    const payload = decodeQualificationCohortScrubRootWorkflowPayload(event.payload);
    if (payload === null) {
      throw new NonRetryableError("invalid qualification cohort scrub root payload");
    }
    try {
      return await runQualificationCohortScrubRoot(
        payload,
        event.instanceId,
        step,
        makePorts(this.env, payload),
        (message) => new NonRetryableError(message, "QualificationCohortScrubRootConflict"),
      );
    } catch (error) {
      if (error instanceof QualificationCohortScrubRootTerminal) {
        throw new NonRetryableError(error.message, "QualificationCohortScrubRootConflict");
      }
      throw error;
    }
  }
}
