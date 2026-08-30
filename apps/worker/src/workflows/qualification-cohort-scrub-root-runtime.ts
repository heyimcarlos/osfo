/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop, eslint/no-underscore-dangle, osfo/no-unknown-parameters -- Cloudflare Workflow, Durable Object, and PostgreSQL ports are Promise-native tagged boundaries; partitions must execute in authority order. */
import type { WorkflowStepConfig } from "cloudflare:workers";
import { Data } from "effect";

import type {
  QualificationScrubPartitionCompletionInspection,
  QualificationScrubRootInspection,
} from "../integrations/postgres/qualification-cohort-scrub";
import type {
  QualificationCohortArtifactFenceOutcome,
  QualificationCohortArtifactInspection,
} from "../qualification/cohort-artifact-authority-contract";
import { qualificationCohortArtifactProtocol } from "../qualification/cohort-artifact-authority-contract";
import {
  decodeQualificationCohortScrubPartitionResult,
  type QualificationCohortScrubPartitionResult,
} from "./qualification-cohort-scrub-partition-runtime";
import {
  decodeQualificationCohortScrubPartitionWake,
  qualificationCohortScrubPartitionInstanceId,
  qualificationCohortScrubPartitionWake,
  type QualificationCohortScrubPartitionWorkflowPayload,
} from "../qualification/cohort-scrub-partition";
import {
  qualificationCohortScrubRootEventTimeout,
  qualificationCohortScrubRootInstanceId,
  qualificationCohortScrubRootPartitionPayload,
  qualificationCohortScrubRootTopology,
  type QualificationCohortScrubRootTopology,
  type QualificationCohortScrubRootWorkflowPayload,
} from "../qualification/cohort-scrub-root";

export const qualificationCohortScrubRootStepConfig = {
  retries: { backoff: "constant", delay: "1 minute", limit: 10 },
  timeout: "30 minutes",
} as const satisfies WorkflowStepConfig;

export interface QualificationCohortScrubRootStep {
  readonly do: <Value extends Rpc.Serializable<Value>>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<Value>,
  ) => Promise<Value>;
  readonly waitForEvent: (
    name: string,
    options: {
      readonly timeout: typeof qualificationCohortScrubRootEventTimeout;
      readonly type: string;
    },
  ) => Promise<{ readonly payload: unknown; readonly type: string }>;
}

export type QualificationCohortScrubChildStatus =
  | "complete"
  | "errored"
  | "paused"
  | "queued"
  | "running"
  | "terminated"
  | "unknown"
  | "waiting"
  | "waitingForPause";

export interface QualificationCohortScrubChildSnapshot {
  readonly id: string;
  readonly output?: QualificationCohortScrubPartitionResult;
  readonly status: QualificationCohortScrubChildStatus;
}

export interface QualificationCohortScrubRootPorts {
  readonly fence: () => Promise<QualificationCohortArtifactFenceOutcome>;
  readonly inspectArtifacts: (
    child: QualificationCohortScrubPartitionWorkflowPayload,
  ) => Promise<QualificationCohortArtifactInspection>;
  readonly inspectChild: (
    child: QualificationCohortScrubPartitionWorkflowPayload,
  ) => Promise<QualificationCohortScrubChildSnapshot>;
  readonly inspectPartitionCompletion: (
    child: QualificationCohortScrubPartitionWorkflowPayload,
  ) => Promise<QualificationScrubPartitionCompletionInspection>;
  readonly inspectTopology: () => Promise<QualificationScrubRootInspection>;
  readonly launchChild: (
    child: QualificationCohortScrubPartitionWorkflowPayload,
  ) => Promise<QualificationCohortScrubChildSnapshot>;
}

export interface QualificationCohortScrubRootResult {
  readonly cohortId: string;
  readonly executionId: string;
  readonly finalPageChecksum: string;
  readonly totalPageCount: number;
  readonly totalPartitionCount: number;
}

export class QualificationCohortScrubRootRetryable extends Data.TaggedError(
  "QualificationCohortScrubRootRetryable",
)<{ readonly message: string }> {}

export class QualificationCohortScrubRootTerminal extends Data.TaggedError(
  "QualificationCohortScrubRootTerminal",
)<{ readonly message: string }> {}

const retryable = (message: string): never => {
  throw new QualificationCohortScrubRootRetryable({ message });
};

const terminal = (message: string): never => {
  throw new QualificationCohortScrubRootTerminal({ message });
};

const exactChildOutput = (
  child: QualificationCohortScrubPartitionWorkflowPayload,
  input: unknown,
): QualificationCohortScrubPartitionResult | null => {
  const output = decodeQualificationCohortScrubPartitionResult(input);
  if (output === null) return null;
  const expectedWake = qualificationCohortScrubPartitionWake(child, output.terminalPageChecksum);
  return output.cohortId === child.cohortId &&
    output.executionId === child.executionId &&
    output.firstPagePosition === child.firstPagePosition &&
    output.pageCount === child.pageCount &&
    output.partitionIndex === child.partitionIndex &&
    output.wake.eventId === expectedWake.eventId &&
    output.wake.eventType === expectedWake.eventType &&
    output.wake.cohortId === expectedWake.cohortId &&
    output.wake.executionId === expectedWake.executionId &&
    output.wake.firstPagePosition === expectedWake.firstPagePosition &&
    output.wake.pageCount === expectedWake.pageCount &&
    output.wake.partitionIndex === expectedWake.partitionIndex &&
    output.wake.protocolVersion === expectedWake.protocolVersion &&
    output.wake.rootCoordinatorInstanceId === child.rootCoordinatorInstanceId &&
    output.wake.terminalPageChecksum === output.terminalPageChecksum
    ? output
    : null;
};

const activeChild = (status: QualificationCohortScrubChildStatus) =>
  status === "queued" || status === "running" || status === "waiting";

const childOutputOrWait = (
  child: QualificationCohortScrubPartitionWorkflowPayload,
  snapshot: QualificationCohortScrubChildSnapshot,
) => {
  const expectedId = qualificationCohortScrubPartitionInstanceId(
    child.executionId,
    child.partitionIndex,
  );
  if (snapshot.id !== expectedId) return terminal("partition Workflow identity conflicts");
  if (snapshot.status === "unknown") return retryable("partition Workflow status is unavailable");
  if (activeChild(snapshot.status)) return null;
  if (snapshot.status !== "complete") {
    return terminal(`partition Workflow entered structural status ${snapshot.status}`);
  }
  const output = exactChildOutput(child, snapshot.output);
  return output ?? terminal("partition Workflow output conflicts");
};

const exactWake = (
  child: QualificationCohortScrubPartitionWorkflowPayload,
  event: { readonly payload: unknown; readonly type: string },
) => {
  const wake = decodeQualificationCohortScrubPartitionWake(event.payload);
  if (wake === null || event.type !== wake.eventType) return null;
  const expected = qualificationCohortScrubPartitionWake(child, wake.terminalPageChecksum);
  return wake.cohortId === expected.cohortId &&
    wake.eventId === expected.eventId &&
    wake.eventType === expected.eventType &&
    wake.executionId === expected.executionId &&
    wake.firstPagePosition === expected.firstPagePosition &&
    wake.pageCount === expected.pageCount &&
    wake.partitionIndex === expected.partitionIndex &&
    wake.protocolVersion === expected.protocolVersion &&
    wake.rootCoordinatorInstanceId === expected.rootCoordinatorInstanceId
    ? wake
    : null;
};

const exactTopology = (
  payload: QualificationCohortScrubRootWorkflowPayload,
  inspection: QualificationScrubRootInspection,
): QualificationCohortScrubRootTopology => {
  if (inspection._tag === "Pending") {
    return terminal(`root PostgreSQL authority missing: ${inspection.reason}`);
  }
  if (inspection._tag === "Conflict") return terminal("root PostgreSQL topology conflicts");
  const expected = qualificationCohortScrubRootTopology(payload, {
    adventurer: inspection.adventurerParticipantCount,
    free: inspection.freeParticipantCount,
  });
  if (
    expected === null ||
    inspection.adventurerPageCount !== expected.adventurerPageCount ||
    inspection.freePageCount !== expected.freePageCount ||
    inspection.partitionCount !== expected.partitionCount ||
    inspection.totalPageCount !== expected.totalPageCount ||
    inspection.totalParticipantCount !== expected.totalParticipantCount
  ) {
    return terminal("root PostgreSQL topology is internally inconsistent");
  }
  return expected;
};

const verifyPartitionAuthority = (
  child: QualificationCohortScrubPartitionWorkflowPayload,
  output: QualificationCohortScrubPartitionResult,
  pg: QualificationScrubPartitionCompletionInspection,
  artifacts: QualificationCohortArtifactInspection,
  finalPartition: boolean,
  previousPageChecksum: string,
) => {
  if (pg._tag === "Pending") return terminal("partition PostgreSQL authority is incomplete");
  if (pg._tag === "Conflict") return terminal("partition PostgreSQL authority conflicts");
  if (
    pg.pageCount !== child.pageCount ||
    pg.partitionIndex !== child.partitionIndex ||
    pg.previousPageChecksum !== previousPageChecksum ||
    pg.terminalPageChecksum !== output.terminalPageChecksum ||
    pg.terminalPosition !== child.firstPagePosition + child.pageCount - 1
  ) {
    return terminal("partition PostgreSQL authority is substituted");
  }
  if (artifacts._tag === "Missing") return terminal("artifact authority is missing");
  if (artifacts._tag === "Conflict")
    return terminal(`artifact authority conflicts: ${artifacts.code}`);
  if (artifacts._tag === "Scrubbed") return terminal("artifact authority was prematurely scrubbed");
  if (
    artifacts.lifecycle !== "FENCED" ||
    !Number.isSafeInteger(artifacts.artifactRecordCount) ||
    artifacts.artifactRecordCount < 2 ||
    (finalPartition && artifacts.artifactRecordCount !== 2) ||
    artifacts.pendingDeleteScope !== null ||
    artifacts.provenDeleteScope !== null ||
    artifacts.sealedPageCount !== child.firstPagePosition + child.pageCount
  ) {
    return terminal("artifact authority partition state conflicts");
  }
  return pg.terminalPageChecksum;
};

export const runQualificationCohortScrubRoot = async (
  payload: QualificationCohortScrubRootWorkflowPayload,
  instanceId: string,
  step: QualificationCohortScrubRootStep,
  ports: QualificationCohortScrubRootPorts,
  terminalError: (message: string) => Error = (message) =>
    new QualificationCohortScrubRootTerminal({ message }),
): Promise<QualificationCohortScrubRootResult> => {
  if (instanceId !== qualificationCohortScrubRootInstanceId(payload.executionId)) {
    return terminal("root Workflow instance identity conflicts");
  }
  const topology = exactTopology(
    payload,
    await step.do(
      "authenticate cohort scrub root topology",
      qualificationCohortScrubRootStepConfig,
      ports.inspectTopology,
    ),
  );
  await step.do(
    "fence cohort artifact authority",
    qualificationCohortScrubRootStepConfig,
    async () => {
      const fenced = await ports.fence();
      if (fenced._tag === "Busy") return retryable("artifact authority is busy while fencing");
      if (fenced._tag === "Missing")
        throw terminalError("artifact authority is missing while fencing");
      if (fenced._tag === "Conflict") {
        throw terminalError(`artifact fence conflicts: ${fenced.code}`);
      }
      if (fenced.protocolVersion !== qualificationCohortArtifactProtocol) {
        throw terminalError("artifact fence protocol conflicts");
      }
      return true;
    },
  );

  let previousPageChecksum = "NONE";
  for (let partitionIndex = 0; partitionIndex < topology.partitionCount; partitionIndex += 1) {
    const child = qualificationCohortScrubRootPartitionPayload(payload, topology, partitionIndex);
    if (child === null) return terminal("root partition topology conflicts");
    const outputAtLaunch = await step.do(
      `launch cohort scrub partition ${partitionIndex.toString().padStart(4, "0")}`,
      qualificationCohortScrubRootStepConfig,
      async () => {
        try {
          return childOutputOrWait(child, await ports.launchChild(child));
        } catch (error) {
          if (error instanceof QualificationCohortScrubRootTerminal) {
            throw terminalError(error.message);
          }
          throw error;
        }
      },
    );
    if (outputAtLaunch === null) {
      const expectedWake = qualificationCohortScrubPartitionWake(
        child,
        "pending-terminal-checksum",
      );
      const event = await step.waitForEvent(
        `wait for cohort scrub partition ${partitionIndex.toString().padStart(4, "0")}`,
        { timeout: qualificationCohortScrubRootEventTimeout, type: expectedWake.eventType },
      );
      if (exactWake(child, event) === null) return terminal("partition wake authority conflicts");
    }
    const verified = await step.do(
      `verify cohort scrub partition ${partitionIndex.toString().padStart(4, "0")}`,
      qualificationCohortScrubRootStepConfig,
      async () => {
        try {
          const snapshot = await ports.inspectChild(child);
          const childOutput = childOutputOrWait(child, snapshot);
          if (childOutput === null)
            return retryable("partition Workflow remains active after wake");
          const pg = await ports.inspectPartitionCompletion(child);
          const artifacts = await ports.inspectArtifacts(child);
          return verifyPartitionAuthority(
            child,
            childOutput,
            pg,
            artifacts,
            partitionIndex === topology.partitionCount - 1,
            previousPageChecksum,
          );
        } catch (error) {
          if (error instanceof QualificationCohortScrubRootTerminal) {
            throw terminalError(error.message);
          }
          throw error;
        }
      },
    );
    previousPageChecksum = verified;
  }
  return {
    cohortId: payload.cohortId,
    executionId: payload.executionId,
    finalPageChecksum: previousPageChecksum,
    totalPageCount: topology.totalPageCount,
    totalPartitionCount: topology.partitionCount,
  };
};

interface WorkflowInstanceLike {
  readonly id: string;
  readonly status: () => Promise<{ readonly output?: unknown; readonly status: string }>;
}

export const qualificationCohortScrubChildSnapshot = async (
  instance: WorkflowInstanceLike,
  expectedId: string,
): Promise<QualificationCohortScrubChildSnapshot> => {
  if (instance.id !== expectedId) return terminal("created partition Workflow identity conflicts");
  const status = await instance.status();
  if (
    status.status !== "complete" &&
    status.status !== "errored" &&
    status.status !== "paused" &&
    status.status !== "queued" &&
    status.status !== "running" &&
    status.status !== "terminated" &&
    status.status !== "unknown" &&
    status.status !== "waiting" &&
    status.status !== "waitingForPause"
  ) {
    return terminal("partition Workflow returned an unknown structural status");
  }
  const output = decodeQualificationCohortScrubPartitionResult(status.output) ?? undefined;
  return output === undefined
    ? { id: instance.id, status: status.status }
    : { id: instance.id, output, status: status.status };
};

export const createOrReconcileQualificationScrubPartition = async (input: {
  readonly create: (options: {
    readonly id: string;
    readonly params: QualificationCohortScrubPartitionWorkflowPayload;
  }) => Promise<WorkflowInstanceLike>;
  readonly get: (id: string) => Promise<WorkflowInstanceLike>;
  readonly id: string;
  readonly params: QualificationCohortScrubPartitionWorkflowPayload;
}): Promise<QualificationCohortScrubChildSnapshot> => {
  let instance: WorkflowInstanceLike;
  try {
    instance = await input.create({ id: input.id, params: input.params });
  } catch (createCause) {
    try {
      instance = await input.get(input.id);
    } catch {
      throw createCause;
    }
  }
  return await qualificationCohortScrubChildSnapshot(instance, input.id);
};
