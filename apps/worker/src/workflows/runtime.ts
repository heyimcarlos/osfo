import { WorkflowEntrypoint, type WorkflowEvent } from "cloudflare:workers";
import { Option } from "effect";

import { runInvocationEffect } from "../adapters/host";
import { decodeOsfoStage } from "../config";
import {
  invalidOsfoEnvironment,
  makeWorkflowRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../layers";

/** Technical Workflow host that proves one Effect runtime per execution callback. */
export class ExecutionUnitWorkflow extends WorkflowEntrypoint<Env, null> {
  /** Run one Workflow execution inside one invocation-scoped Effect runtime. */
  override run(event: Readonly<WorkflowEvent<null>>): Promise<RuntimeProbeResult> {
    const stage = decodeOsfoStage(this.env.OSFO_STAGE);

    return Option.match(stage, {
      onNone: () => Promise.resolve(invalidOsfoEnvironment),
      onSome: (parsedStage) =>
        runInvocationEffect(makeWorkflowRuntime(event.instanceId, parsedStage), probeExecutionUnit),
    });
  }
}
