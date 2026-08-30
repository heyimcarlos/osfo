/* oxlint-disable effecttsgo/async-function, effecttsgo/global-timers, effecttsgo/new-promise, eslint/no-await-in-loop -- The real Workflows host is Promise-native and status polling is intentionally bounded. */
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { expect, it } from "vitest";

import {
  qualificationCohortScrubPartitionInstanceId,
  qualificationCohortScrubPartitionProtocol,
  qualificationCohortScrubPartitionWake,
  type QualificationCohortScrubPartitionWorkflowPayload,
} from "../qualification/cohort-scrub-partition";

interface TestEnv {
  readonly QUALIFICATION_COHORT_SCRUB_PARTITION_WORKFLOW: Workflow<QualificationCohortScrubPartitionWorkflowPayload>;
}

// @ts-expect-error The focused runtime config owns this exact test-only generated binding.
const runtimeEnv: TestEnv = env;

const terminalStatus = async (instance: WorkflowInstance): Promise<InstanceStatus> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await instance.status();
    if (
      status.status === "complete" ||
      status.status === "errored" ||
      status.status === "terminated"
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The qualification scrub partition Workflow did not settle");
};

it("fails an invalid partition payload non-retryably in the real Workflows host", async () => {
  const executionId = "invalid-scrub-partition-runtime-v1";
  const instance = await runtimeEnv.QUALIFICATION_COHORT_SCRUB_PARTITION_WORKFLOW.create({
    id: qualificationCohortScrubPartitionInstanceId(executionId, 0),
    params: {
      cohortId: "invalid-cohort",
      executionId,
      firstPagePosition: 0,
      pageCount: 33,
      partitionIndex: 0,
      protocolVersion: qualificationCohortScrubPartitionProtocol,
      rootCoordinatorInstanceId: "invalid-root",
    },
  });

  await expect(terminalStatus(instance)).resolves.toMatchObject({ status: "errored" });
});

it("serializes a compact successful partition through the real Workflows host", async () => {
  const executionId = "scrub-partition-runtime-v1";
  const params = {
    cohortId: "scrub-cohort",
    executionId,
    firstPagePosition: 0,
    pageCount: 1,
    partitionIndex: 0,
    protocolVersion: qualificationCohortScrubPartitionProtocol,
    rootCoordinatorInstanceId: "scrub-root",
  } as const;
  const instanceId = qualificationCohortScrubPartitionInstanceId(executionId, 0);
  await using introspector = await introspectWorkflowInstance(
    runtimeEnv.QUALIFICATION_COHORT_SCRUB_PARTITION_WORKFLOW,
    instanceId,
  );
  await introspector.modify(async (modifier) => {
    await modifier.mockStepResult(
      { name: "authenticate cohort scrub partition topology" },
      {
        _tag: "Ready",
        firstPagePosition: 0,
        freeParticipantCount: 1,
        pageCount: 1,
        pages: [{ pageIndex: 0, plan: "free", position: 0 }],
        partitionIndex: 0,
        totalPageCount: 1,
      },
    );
    await modifier.mockStepResult(
      { name: "scrub cohort artifact page 0000" },
      {
        pageChecksum: "page-checksum",
        pageIndex: 0,
        plan: "free",
        position: 0,
        proofChecksum: "proof-checksum",
      },
    );
    await modifier.mockStepResult(
      { name: "notify cohort scrub root partition 0000" },
      qualificationCohortScrubPartitionWake(params, "page-checksum"),
    );
  });
  await runtimeEnv.QUALIFICATION_COHORT_SCRUB_PARTITION_WORKFLOW.create({
    id: instanceId,
    params,
  });

  await expect(introspector.waitForStatus("complete")).resolves.not.toThrow();
  await expect(introspector.getOutput()).resolves.toMatchObject({
    cohortId: params.cohortId,
    executionId,
    firstPagePosition: 0,
    pageCount: 1,
    partitionIndex: 0,
    terminalPageChecksum: "page-checksum",
    wake: {
      eventType: "qualification-scrub-partition-0000",
      rootCoordinatorInstanceId: params.rootCoordinatorInstanceId,
    },
  });
});
