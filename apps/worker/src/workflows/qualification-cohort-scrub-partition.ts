/* oxlint-disable effecttsgo/async-function -- Cloudflare Workflow, Durable Object RPC, and Hyperdrive are Promise-native host boundaries. */
import { createDb } from "@osfo/db";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect } from "effect";
import postgres from "postgres";

import type { QualificationCohortArtifactAuthority } from "../qualification-cohort-artifact-authority";
import {
  deleteQualificationCohortArtifactPage,
  sealQualificationCohortArtifactPage,
} from "../integrations/cloudflare/qualification-cohort-artifacts";
import { makeQualificationCohortScrubAuthority } from "../integrations/postgres/qualification-cohort-scrub";
import { decodeQualificationCohortScrubPartitionWorkflowPayload } from "../qualification/cohort-scrub-partition";
import type { QualificationCohortScrubRootWorkflowPayload } from "../qualification/cohort-scrub-root";
import type { QualificationCohortScrubPartitionWorkflowPayload } from "../workflow-contracts";
import {
  runQualificationCohortScrubPartition,
  type QualificationCohortScrubPageAuthority,
  type QualificationCohortScrubPartitionPorts,
  type QualificationCohortScrubPartitionResult,
} from "./qualification-cohort-scrub-partition-runtime";

interface QualificationCohortScrubPartitionEnv {
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly QUALIFICATION_COHORT_ARTIFACT_AUTHORITY: DurableObjectNamespace<QualificationCohortArtifactAuthority>;
  readonly QUALIFICATION_COHORT_SCRUB_ROOT_WORKFLOW: Workflow<QualificationCohortScrubRootWorkflowPayload>;
}

const withDatabase = async <Value>(
  env: QualificationCohortScrubPartitionEnv,
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
  env: QualificationCohortScrubPartitionEnv,
  payload: QualificationCohortScrubPartitionWorkflowPayload,
): QualificationCohortScrubPartitionPorts => ({
  inspectTopology: (input) =>
    withDatabase(env, (authority) => Effect.runPromise(authority.inspectScrubPartition(input))),
  notifyRoot: async (wake) => {
    const instance = await env.QUALIFICATION_COHORT_SCRUB_ROOT_WORKFLOW.get(
      wake.rootCoordinatorInstanceId,
    );
    if (instance.id !== wake.rootCoordinatorInstanceId) {
      throw new Error("The cohort scrub root Workflow identity conflicts");
    }
    await instance.sendEvent({ payload: wake, type: wake.eventType });
    return wake;
  },
  withPageAuthority: (evaluate) =>
    withDatabase(env, async (authority) => {
      const pageAuthority: QualificationCohortScrubPageAuthority = {
        claim: (claimToken, page) =>
          Effect.runPromise(
            authority.claimScrubPage({
              claimToken,
              cohortId: payload.cohortId,
              executionId: payload.executionId,
              pageIndex: page.pageIndex,
              plan: page.plan,
            }),
          ),
        complete: (input) =>
          Effect.runPromise(
            authority.completeScrubPage({
              ...input,
              cohortId: payload.cohortId,
              executionId: payload.executionId,
            }),
          ),
        deletePage: (input) =>
          Effect.runPromise(
            deleteQualificationCohortArtifactPage(
              env.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY,
              input,
            ),
          ),
        sealPage: (input) =>
          Effect.runPromise(
            sealQualificationCohortArtifactPage(env.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY, input),
          ),
      };
      return await evaluate(pageAuthority);
    }),
});

/** One bounded exact-order cohort artifact scrub partition. PostgreSQL rows remain authority. */
export class QualificationCohortScrubPartitionWorkflow extends WorkflowEntrypoint<
  QualificationCohortScrubPartitionEnv,
  QualificationCohortScrubPartitionWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<QualificationCohortScrubPartitionWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<QualificationCohortScrubPartitionResult> {
    const payload = decodeQualificationCohortScrubPartitionWorkflowPayload(event.payload);
    if (payload === null) {
      throw new NonRetryableError("invalid qualification cohort scrub partition payload");
    }
    return await runQualificationCohortScrubPartition(
      payload,
      event.instanceId,
      step,
      makePorts(this.env, payload),
      (message) => new NonRetryableError(message, "QualificationCohortScrubPartitionConflict"),
    );
  }
}
