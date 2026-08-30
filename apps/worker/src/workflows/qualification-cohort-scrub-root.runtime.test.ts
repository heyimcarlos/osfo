/* oxlint-disable effecttsgo/async-function, effecttsgo/global-timers, effecttsgo/new-promise, eslint/no-await-in-loop -- The real Workflows host is Promise-native and status polling is intentionally bounded. */
import { env } from "cloudflare:test";
import { expect, it } from "vitest";

import { qualificationCohortScrubRootInstanceId } from "../qualification/cohort-scrub-root";

interface TestEnv {
  readonly QUALIFICATION_COHORT_SCRUB_ROOT_WORKFLOW: Workflow;
}

// @ts-expect-error The focused runtime config owns this exact generated Workflow binding.
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
  throw new Error("The qualification scrub root Workflow did not settle");
};

it("fails an invalid compact root payload nonretryably in the real Workflows host", async () => {
  const executionId = "invalid-scrub-root-runtime-v1";
  const instance = await runtimeEnv.QUALIFICATION_COHORT_SCRUB_ROOT_WORKFLOW.create({
    id: qualificationCohortScrubRootInstanceId(executionId),
    params: {
      cohortId: "invalid-cohort",
      executionId,
      protocolVersion: "wrong-protocol",
    },
  });

  await expect(terminalStatus(instance)).resolves.toMatchObject({ status: "errored" });
});
