/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop, eslint/no-underscore-dangle, osfo/no-unknown-parameters -- Cloudflare Workflow, Durable Object, and PostgreSQL ports are Promise-native tagged boundaries; partitions must execute in authority order. */
import type { WorkflowStepConfig } from "cloudflare:workers";
import { Data } from "effect";

import type {
  QualificationScrubRootClaim,
  QualificationScrubRootCompletion,
  QualificationScrubRootCompletionInspection,
  QualificationScrubPartitionCompletionInspection,
  QualificationScrubRootInspection,
} from "../integrations/postgres/qualification-cohort-scrub";
import type {
  QualificationCohortArtifactDeleteOutcome,
  QualificationCohortArtifactFenceOutcome,
  QualificationCohortArtifactInspection,
  QualificationCohortArtifactSealRootOutcome,
} from "../qualification/cohort-artifact-authority-contract";
import { qualificationCohortArtifactProtocol } from "../qualification/cohort-artifact-authority-contract";
import { qualificationChecksum } from "../qualification/qualification-checksum";
import { qualificationCohortRootArtifactKeys } from "../qualification/cohort-artifact-layout";
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
  qualificationCohortArtifactRecordCount,
  qualificationCohortScrubRootClaimToken,
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

export const qualificationCohortScrubRootFinalizationStepConfig = {
  retries: { backoff: "constant", delay: "6 minutes", limit: 10 },
  timeout: "30 minutes",
} as const satisfies WorkflowStepConfig;

export interface QualificationCohortScrubRootStep {
  readonly do: <Value extends Rpc.Serializable<Value>>(
    name: string,
    config: WorkflowStepConfig,
    callback: (context: { readonly attempt: number }) => Promise<Value>,
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
  readonly inspectFenceArtifacts: () => Promise<QualificationCohortArtifactInspection>;
  readonly inspectFinalArtifacts: () => Promise<QualificationCohortArtifactInspection>;
  readonly inspectArtifacts: (
    child: QualificationCohortScrubPartitionWorkflowPayload,
  ) => Promise<QualificationCohortArtifactInspection>;
  readonly inspectChild: (
    child: QualificationCohortScrubPartitionWorkflowPayload,
  ) => Promise<QualificationCohortScrubChildSnapshot>;
  readonly inspectPartitionCompletion: (
    child: QualificationCohortScrubPartitionWorkflowPayload,
  ) => Promise<QualificationScrubPartitionCompletionInspection>;
  readonly inspectRootCompletion: () => Promise<QualificationScrubRootCompletionInspection>;
  readonly inspectTopology: () => Promise<QualificationScrubRootInspection>;
  readonly launchChild: (
    child: QualificationCohortScrubPartitionWorkflowPayload,
  ) => Promise<QualificationCohortScrubChildSnapshot>;
  readonly withRootAuthority: <Value>(
    evaluate: (authority: QualificationCohortScrubRootAuthority) => Promise<Value>,
  ) => Promise<Value>;
}

export interface QualificationCohortScrubRootAuthority {
  readonly claim: (claimToken: string) => Promise<QualificationScrubRootClaim>;
  readonly complete: (input: {
    readonly artifactAuthorityProofChecksum: string;
    readonly claimToken: string;
    readonly deletedArtifactCount: number;
    readonly deletedArtifactsChecksum: string;
  }) => Promise<QualificationScrubRootCompletion>;
  readonly deleteRoot: (input: {
    readonly executionId: string;
    readonly expectedArtifactKeys: ReadonlyArray<string>;
    readonly expectedArtifactsChecksum: string;
    readonly expectedPageCount: number;
    readonly finalPageChecksum: string;
    readonly protocolVersion: typeof qualificationCohortArtifactProtocol;
  }) => Promise<QualificationCohortArtifactDeleteOutcome>;
  readonly sealRoot: (input: {
    readonly executionId: string;
    readonly proofChecksum: string;
    readonly protocolVersion: typeof qualificationCohortArtifactProtocol;
    readonly rootChecksum: string;
  }) => Promise<QualificationCohortArtifactSealRootOutcome>;
}

export interface QualificationCohortScrubRootResult {
  readonly cohortId: string;
  readonly executionId: string;
  readonly finalPageChecksum: string;
  readonly rootChecksum: string;
  readonly state: "SCRUBBED";
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
  previousArtifactRecordCount: number,
  previousPageChecksum: string,
) => {
  if (pg._tag === "Pending") return terminal("partition PostgreSQL authority is incomplete");
  if (pg._tag === "Conflict") return terminal("partition PostgreSQL authority conflicts");
  if (
    !Number.isSafeInteger(pg.deletedArtifactCount) ||
    pg.deletedArtifactCount <= 0 ||
    pg.pageCount !== child.pageCount ||
    pg.partitionIndex !== child.partitionIndex ||
    pg.previousPageChecksum !== previousPageChecksum ||
    pg.terminalPageChecksum !== output.terminalPageChecksum ||
    pg.terminalPosition !== child.firstPagePosition + child.pageCount - 1
  ) {
    return terminal("partition PostgreSQL authority is substituted");
  }
  const expectedArtifactRecordCount = previousArtifactRecordCount - pg.deletedArtifactCount;
  if (!Number.isSafeInteger(expectedArtifactRecordCount) || expectedArtifactRecordCount < 2) {
    return terminal("partition artifact deletion count conflicts with the root ledger");
  }
  verifyArtifactAuthorityState(
    artifacts,
    expectedArtifactRecordCount,
    child.firstPagePosition + child.pageCount,
  );
  return {
    artifactRecordCount: expectedArtifactRecordCount,
    terminalPageChecksum: pg.terminalPageChecksum,
  };
};

const verifyArtifactAuthorityState = (
  artifacts: QualificationCohortArtifactInspection,
  expectedArtifactRecordCount: number,
  expectedSealedPageCount: number,
) => {
  if (artifacts._tag === "Missing") return terminal("artifact authority is missing");
  if (artifacts._tag === "Conflict") {
    return terminal(`artifact authority conflicts: ${artifacts.code}`);
  }
  if (artifacts._tag === "Scrubbed") return terminal("artifact authority was prematurely scrubbed");
  if (
    artifacts.lifecycle !== "FENCED" ||
    !Number.isSafeInteger(artifacts.artifactRecordCount) ||
    artifacts.artifactRecordCount !== expectedArtifactRecordCount ||
    artifacts.pendingDeleteScope !== null ||
    artifacts.provenDeleteScope !== null ||
    artifacts.sealedPageCount !== expectedSealedPageCount
  ) {
    return terminal("artifact authority ledger conflicts");
  }
  return true;
};

const exactRootArtifacts = (
  payload: QualificationCohortScrubRootWorkflowPayload,
  topology: QualificationCohortScrubRootTopology,
  finalPageChecksum: string,
  claim: Extract<QualificationScrubRootClaim, { readonly _tag: "Claimed" | "Completed" }>,
) => {
  const keys = qualificationCohortRootArtifactKeys(payload.executionId);
  const expectedArtifactsChecksum = qualificationChecksum({ expectedArtifactIds: keys });
  if (
    claim.cohortId !== payload.cohortId ||
    claim.executionId !== payload.executionId ||
    claim.expectedArtifactCount !== keys.length ||
    claim.expectedArtifactsChecksum !== expectedArtifactsChecksum ||
    claim.expectedPageCount !== topology.totalPageCount ||
    claim.expectedParticipantCount !== topology.totalParticipantCount ||
    claim.finalPageChecksum !== finalPageChecksum ||
    (claim._tag === "Claimed" &&
      (claim.expectedArtifactIds.length !== keys.length ||
        claim.expectedArtifactIds.some((key, index) => key !== keys[index])))
  ) {
    return null;
  }
  return { expectedArtifactsChecksum, keys };
};

const sealExactRoot = async (
  authority: QualificationCohortScrubRootAuthority,
  executionId: string,
  proofChecksum: string,
  rootChecksum: string,
) => {
  const sealed = await authority.sealRoot({
    executionId,
    proofChecksum,
    protocolVersion: qualificationCohortArtifactProtocol,
    rootChecksum,
  });
  if (sealed._tag === "Busy") return retryable("artifact authority is busy while sealing root");
  if (sealed._tag === "Missing") return terminal(`artifact root seal missing: ${sealed.code}`);
  if (sealed._tag === "Conflict") return terminal(`artifact root seal conflicts: ${sealed.code}`);
  if (sealed.rootChecksum !== rootChecksum) {
    return terminal("artifact root seal returned a substituted checksum");
  }
  return { artifactAuthorityProofChecksum: proofChecksum, rootChecksum };
};

export const advanceQualificationCohortScrubRoot = async (
  authority: QualificationCohortScrubRootAuthority,
  payload: QualificationCohortScrubRootWorkflowPayload,
  topology: QualificationCohortScrubRootTopology,
  finalPageChecksum: string,
  attempt: number,
) => {
  if (!Number.isSafeInteger(attempt) || attempt <= 0) return terminal("invalid Workflow attempt");
  const claimToken = qualificationCohortScrubRootClaimToken(payload, attempt);
  const claim = await authority.claim(claimToken);
  if (claim._tag === "Busy" || claim._tag === "LeaseExpired") {
    return retryable(`PostgreSQL root claim is ${claim._tag}`);
  }
  if (claim._tag === "Pending") {
    return terminal(`PostgreSQL root authority missing: ${claim.reason}`);
  }
  if (claim._tag === "Conflict") return terminal("PostgreSQL root authority conflicts");
  const exact = exactRootArtifacts(payload, topology, finalPageChecksum, claim);
  if (exact === null) return terminal("PostgreSQL root descriptor conflicts with topology");
  if (claim._tag === "Completed") {
    if (claim.artifactAuthorityProofChecksum.length === 0 || claim.rootChecksum.length === 0) {
      return terminal("completed PostgreSQL root authority is incomplete");
    }
    return await sealExactRoot(
      authority,
      payload.executionId,
      claim.artifactAuthorityProofChecksum,
      claim.rootChecksum,
    );
  }
  const deleted = await authority.deleteRoot({
    executionId: payload.executionId,
    expectedArtifactKeys: exact.keys,
    expectedArtifactsChecksum: exact.expectedArtifactsChecksum,
    expectedPageCount: topology.totalPageCount,
    finalPageChecksum,
    protocolVersion: qualificationCohortArtifactProtocol,
  });
  if (deleted._tag === "Busy" || deleted._tag === "Retryable") {
    return retryable(`artifact root deletion is ${deleted._tag}`);
  }
  if (deleted._tag === "Missing") {
    return terminal(`artifact root deletion authority missing: ${deleted.code}`);
  }
  if (deleted._tag === "Conflict") {
    return terminal(`artifact root deletion authority conflicts: ${deleted.code}`);
  }
  if (
    deleted.scope !== "root" ||
    deleted.expectedArtifactCount !== claim.expectedArtifactCount ||
    deleted.expectedArtifactsChecksum !== claim.expectedArtifactsChecksum ||
    deleted.artifactRecordsChecksum.length === 0 ||
    deleted.operationId.length === 0 ||
    deleted.proofChecksum.length === 0
  ) {
    return terminal("artifact root deletion proof conflicts with PostgreSQL authority");
  }
  const completed = await authority.complete({
    artifactAuthorityProofChecksum: deleted.proofChecksum,
    claimToken,
    deletedArtifactCount: deleted.expectedArtifactCount,
    deletedArtifactsChecksum: deleted.expectedArtifactsChecksum,
  });
  if (completed._tag === "LeaseExpired") {
    return retryable("PostgreSQL root completion lease expired");
  }
  if (completed._tag === "Conflict") return terminal("PostgreSQL root completion conflicts");
  if (
    completed.artifactAuthorityProofChecksum !== deleted.proofChecksum ||
    completed.rootChecksum.length === 0
  ) {
    return terminal("PostgreSQL root completion substituted authority");
  }
  return await sealExactRoot(
    authority,
    payload.executionId,
    completed.artifactAuthorityProofChecksum,
    completed.rootChecksum,
  );
};

const verifyFinalAgreement = (
  payload: QualificationCohortScrubRootWorkflowPayload,
  topology: QualificationCohortScrubRootTopology,
  finalPageChecksum: string,
  finalized: { readonly artifactAuthorityProofChecksum: string; readonly rootChecksum: string },
  pg: QualificationScrubRootCompletionInspection,
  artifacts: QualificationCohortArtifactInspection,
) => {
  if (pg._tag === "Missing") return terminal(`PostgreSQL root completion missing: ${pg.reason}`);
  if (pg._tag === "Conflict") return terminal("PostgreSQL root completion conflicts");
  if (
    pg.cohortId !== payload.cohortId ||
    pg.executionId !== payload.executionId ||
    pg.expectedPageCount !== topology.totalPageCount ||
    pg.expectedParticipantCount !== topology.totalParticipantCount ||
    pg.finalPageChecksum !== finalPageChecksum ||
    pg.allocationIdentityCount !== 0 ||
    pg.provisionIdentityCount !== 0 ||
    pg.artifactAuthorityProofChecksum !== finalized.artifactAuthorityProofChecksum ||
    pg.rootChecksum !== finalized.rootChecksum
  ) {
    return terminal("PostgreSQL final root authority is substituted");
  }
  if (artifacts._tag === "Missing") return terminal("final artifact authority is missing");
  if (artifacts._tag === "Conflict") {
    return terminal(`final artifact authority conflicts: ${artifacts.code}`);
  }
  if (artifacts._tag === "Present") {
    return terminal("final artifact authority is not scrubbed");
  }
  if (artifacts.rootChecksum !== finalized.rootChecksum) {
    return terminal("PostgreSQL and artifact root checksums disagree");
  }
  return finalized.rootChecksum;
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
  const initialArtifactRecordCount = qualificationCohortArtifactRecordCount(topology);
  if (initialArtifactRecordCount === null) {
    return terminal("root artifact ledger is invalid");
  }
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
      try {
        verifyArtifactAuthorityState(
          await ports.inspectFenceArtifacts(),
          initialArtifactRecordCount,
          0,
        );
      } catch (error) {
        if (error instanceof QualificationCohortScrubRootTerminal) {
          throw terminalError(error.message);
        }
        throw error;
      }
      return true;
    },
  );

  let previousPageChecksum = "NONE";
  let remainingArtifactRecordCount = initialArtifactRecordCount;
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
            remainingArtifactRecordCount,
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
    remainingArtifactRecordCount = verified.artifactRecordCount;
    previousPageChecksum = verified.terminalPageChecksum;
  }
  if (remainingArtifactRecordCount !== 2) {
    return terminal("root artifact ledger did not retain exactly two root records");
  }
  const finalized = await step.do(
    "delete and seal cohort artifact root",
    qualificationCohortScrubRootFinalizationStepConfig,
    async (context) => {
      try {
        return await ports.withRootAuthority((authority) =>
          advanceQualificationCohortScrubRoot(
            authority,
            payload,
            topology,
            previousPageChecksum,
            context.attempt,
          ),
        );
      } catch (error) {
        if (error instanceof QualificationCohortScrubRootTerminal) {
          throw terminalError(error.message);
        }
        throw error;
      }
    },
  );
  const rootChecksum = await step.do(
    "authenticate scrubbed cohort root agreement",
    qualificationCohortScrubRootStepConfig,
    async () => {
      try {
        return verifyFinalAgreement(
          payload,
          topology,
          previousPageChecksum,
          finalized,
          await ports.inspectRootCompletion(),
          await ports.inspectFinalArtifacts(),
        );
      } catch (error) {
        if (error instanceof QualificationCohortScrubRootTerminal) {
          throw terminalError(error.message);
        }
        throw error;
      }
    },
  );
  return {
    cohortId: payload.cohortId,
    executionId: payload.executionId,
    finalPageChecksum: previousPageChecksum,
    rootChecksum,
    state: "SCRUBBED",
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
