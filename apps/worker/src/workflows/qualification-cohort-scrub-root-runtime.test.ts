/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Promise fakes model Cloudflare Workflow, Durable Object, and PostgreSQL boundaries. */
import { describe, expect, it } from "vitest";
import type { WorkflowStepConfig } from "cloudflare:workers";

import { qualificationCohortArtifactProtocol } from "../qualification/cohort-artifact-authority-contract";
import {
  qualificationCohortScrubPartitionInstanceId,
  qualificationCohortScrubPartitionWake,
  type QualificationCohortScrubPartitionWorkflowPayload,
} from "../qualification/cohort-scrub-partition";
import {
  qualificationCohortArtifactRecordCount,
  qualificationCohortScrubRootInstanceId,
  qualificationCohortScrubRootPartitionPayload,
  qualificationCohortScrubRootTopology,
  qualificationCohortScrubRootWorkflowPayload,
} from "../qualification/cohort-scrub-root";
import {
  createOrReconcileQualificationScrubPartition,
  QualificationCohortScrubRootRetryable,
  QualificationCohortScrubRootTerminal,
  qualificationCohortScrubRootStepConfig,
  runQualificationCohortScrubRoot,
  type QualificationCohortScrubChildSnapshot,
  type QualificationCohortScrubRootPorts,
  type QualificationCohortScrubRootStep,
} from "./qualification-cohort-scrub-root-runtime";

const payload = qualificationCohortScrubRootWorkflowPayload("scrub-cohort", "scrub-execution");
const topology = qualificationCohortScrubRootTopology(payload, { adventurer: 0, free: 825 });
if (topology === null) throw new Error("The root topology fixture must be valid");
const initialArtifactRecordCount = qualificationCohortArtifactRecordCount(topology);
if (initialArtifactRecordCount === null) throw new Error("The root ledger fixture must be valid");

const childPayload = (partitionIndex: number) => {
  const child = qualificationCohortScrubRootPartitionPayload(payload, topology, partitionIndex);
  if (child === null) throw new Error("The child topology fixture must be valid");
  return child;
};

const childOutput = (child: QualificationCohortScrubPartitionWorkflowPayload) => {
  const terminalPageChecksum = `page-${child.firstPagePosition + child.pageCount - 1}`;
  return {
    cohortId: child.cohortId,
    executionId: child.executionId,
    firstPagePosition: child.firstPagePosition,
    pageCount: child.pageCount,
    partitionIndex: child.partitionIndex,
    terminalPageChecksum,
    wake: qualificationCohortScrubPartitionWake(child, terminalPageChecksum),
  };
};

class ImmediateRootStep implements QualificationCohortScrubRootStep {
  readonly calls = new Array<string>();
  readonly events = new Array<string>();
  constructor(
    readonly eventFor: (eventType: string) => Promise<{
      readonly payload: unknown;
      readonly type: string;
    }>,
  ) {}

  do<Value extends Rpc.Serializable<Value>>(
    name: string,
    _config: WorkflowStepConfig,
    callback: () => Promise<Value>,
  ): Promise<Value> {
    this.calls.push(name);
    return callback();
  }

  waitForEvent(
    name: string,
    options: { readonly timeout: "7 days"; readonly type: string },
  ): Promise<{ readonly payload: unknown; readonly type: string }> {
    this.calls.push(name);
    this.events.push(options.type);
    return this.eventFor(options.type);
  }
}

const readyPg = (child: QualificationCohortScrubPartitionWorkflowPayload) => ({
  _tag: "Ready" as const,
  deletedArtifactCount: child.partitionIndex === 0 ? 848 : 27,
  pageCount: child.pageCount,
  partitionIndex: child.partitionIndex,
  previousPageChecksum:
    child.firstPagePosition === 0 ? "NONE" : `page-${child.firstPagePosition - 1}`,
  terminalPageChecksum: `page-${child.firstPagePosition + child.pageCount - 1}`,
  terminalPosition: child.firstPagePosition + child.pageCount - 1,
});

const completedSnapshot = (
  child: QualificationCohortScrubPartitionWorkflowPayload,
): QualificationCohortScrubChildSnapshot => ({
  id: qualificationCohortScrubPartitionInstanceId(child.executionId, child.partitionIndex),
  output: childOutput(child),
  status: "complete",
});

const ports = (
  calls: Array<string>,
  overrides: Partial<QualificationCohortScrubRootPorts> = {},
): QualificationCohortScrubRootPorts => ({
  fence: () => {
    calls.push("fence");
    return Promise.resolve({
      _tag: "Fenced",
      protocolVersion: qualificationCohortArtifactProtocol,
    });
  },
  inspectArtifacts: (child) => {
    calls.push(`do:${child.partitionIndex}`);
    return Promise.resolve({
      _tag: "Present",
      artifactRecordCount: child.partitionIndex === 1 ? 2 : 29,
      lifecycle: "FENCED",
      pendingDeleteScope: null,
      provenDeleteScope: null,
      sealedPageCount: child.firstPagePosition + child.pageCount,
    });
  },
  inspectFenceArtifacts: () => {
    calls.push("fence-do");
    return Promise.resolve({
      _tag: "Present",
      artifactRecordCount: initialArtifactRecordCount,
      lifecycle: "FENCED",
      pendingDeleteScope: null,
      provenDeleteScope: null,
      sealedPageCount: 0,
    });
  },
  inspectChild: (child) => {
    calls.push(`child:${child.partitionIndex}`);
    return Promise.resolve(completedSnapshot(child));
  },
  inspectPartitionCompletion: (child) => {
    calls.push(`pg:${child.partitionIndex}`);
    return Promise.resolve(readyPg(child));
  },
  inspectTopology: () => {
    calls.push("topology");
    return Promise.resolve({ _tag: "Ready", ...topology });
  },
  launchChild: (child) => {
    calls.push(`launch:${child.partitionIndex}`);
    return Promise.resolve({
      id: qualificationCohortScrubPartitionInstanceId(child.executionId, child.partitionIndex),
      status: "running",
    });
  },
  ...overrides,
});

describe("qualification cohort scrub root runtime", () => {
  it("launches, waits, and verifies every partition strictly in authority order", async () => {
    const calls = new Array<string>();
    const step = new ImmediateRootStep((eventType) => {
      const partitionIndex = eventType.endsWith("0000") ? 0 : 1;
      const child = childPayload(partitionIndex);
      return Promise.resolve({
        payload: qualificationCohortScrubPartitionWake(
          child,
          `page-${child.firstPagePosition + child.pageCount - 1}`,
        ),
        type: eventType,
      });
    });
    const result = await runQualificationCohortScrubRoot(
      payload,
      qualificationCohortScrubRootInstanceId(payload.executionId),
      step,
      ports(calls),
    );

    expect(calls).toEqual([
      "topology",
      "fence",
      "fence-do",
      "launch:0",
      "child:0",
      "pg:0",
      "do:0",
      "launch:1",
      "child:1",
      "pg:1",
      "do:1",
    ]);
    expect(step.events).toEqual([
      "qualification-scrub-partition-0000",
      "qualification-scrub-partition-0001",
    ]);
    expect(result).toEqual({
      cohortId: payload.cohortId,
      executionId: payload.executionId,
      finalPageChecksum: "page-32",
      totalPageCount: 33,
      totalPartitionCount: 2,
    });
  });

  it("skips the wake only for an already-complete exact child", async () => {
    const calls = new Array<string>();
    const step = new ImmediateRootStep(() => Promise.reject(new Error("unexpected event wait")));
    const oneTopology = qualificationCohortScrubRootTopology(payload, {
      adventurer: 0,
      free: 25,
    });
    if (oneTopology === null) throw new Error("The one-page topology must be valid");
    await expect(
      runQualificationCohortScrubRoot(
        payload,
        qualificationCohortScrubRootInstanceId(payload.executionId),
        step,
        ports(calls, {
          inspectArtifacts: (child) =>
            Promise.resolve({
              _tag: "Present",
              artifactRecordCount: 2,
              lifecycle: "FENCED",
              pendingDeleteScope: null,
              provenDeleteScope: null,
              sealedPageCount: child.firstPagePosition + child.pageCount,
            }),
          inspectTopology: () => Promise.resolve({ _tag: "Ready", ...oneTopology }),
          inspectFenceArtifacts: () =>
            Promise.resolve({
              _tag: "Present",
              artifactRecordCount: 29,
              lifecycle: "FENCED",
              pendingDeleteScope: null,
              provenDeleteScope: null,
              sealedPageCount: 0,
            }),
          inspectPartitionCompletion: (child) =>
            Promise.resolve({ ...readyPg(child), deletedArtifactCount: 27 }),
          launchChild: (child) => Promise.resolve(completedSnapshot(child)),
        }),
      ),
    ).resolves.toMatchObject({ totalPartitionCount: 1 });
    expect(step.events).toEqual([]);
  });

  it("retries a busy fence and rejects missing or conflicting fence authority", async () => {
    const step = new ImmediateRootStep(() => Promise.reject(new Error("unexpected event")));
    await expect(
      runQualificationCohortScrubRoot(
        payload,
        qualificationCohortScrubRootInstanceId(payload.executionId),
        step,
        ports([], { fence: () => Promise.resolve({ _tag: "Busy" }) }),
      ),
    ).rejects.toBeInstanceOf(QualificationCohortScrubRootRetryable);
    await Promise.all(
      ([{ _tag: "Missing" }, { _tag: "Conflict", code: "identity" }] as const).map(
        async (fenced) =>
          await expect(
            runQualificationCohortScrubRoot(
              payload,
              qualificationCohortScrubRootInstanceId(payload.executionId),
              step,
              ports([], { fence: () => Promise.resolve(fenced) }),
            ),
          ).rejects.toBeInstanceOf(QualificationCohortScrubRootTerminal),
      ),
    );
  });

  it("rejects missing, extra, or unsettled records at the exact fence baseline", async () => {
    const step = new ImmediateRootStep(() => Promise.reject(new Error("unexpected event")));
    await Promise.all(
      [
        { artifactRecordCount: initialArtifactRecordCount - 1 },
        { artifactRecordCount: initialArtifactRecordCount + 1 },
        { pendingDeleteScope: "page" as const },
        { sealedPageCount: 1 },
      ].map(
        async (change) =>
          await expect(
            runQualificationCohortScrubRoot(
              payload,
              qualificationCohortScrubRootInstanceId(payload.executionId),
              step,
              ports([], {
                inspectFenceArtifacts: () =>
                  Promise.resolve({
                    _tag: "Present",
                    artifactRecordCount: initialArtifactRecordCount,
                    lifecycle: "FENCED",
                    pendingDeleteScope: null,
                    provenDeleteScope: null,
                    sealedPageCount: 0,
                    ...change,
                  }),
              }),
            ),
          ).rejects.toBeInstanceOf(QualificationCohortScrubRootTerminal),
      ),
    );
  });

  it("does not let a duplicate or substituted partition event advance another partition", async () => {
    const wrong = childPayload(0);
    const step = new ImmediateRootStep((eventType) =>
      Promise.resolve({
        payload: qualificationCohortScrubPartitionWake(wrong, "page-31"),
        type: eventType,
      }),
    );
    await expect(
      runQualificationCohortScrubRoot(
        payload,
        qualificationCohortScrubRootInstanceId(payload.executionId),
        step,
        ports([]),
      ),
    ).rejects.toBeInstanceOf(QualificationCohortScrubRootTerminal);
  });

  it("rejects partial PG authority and an inconsistent DO lifecycle, intent, or count", async () => {
    const oneTopology = qualificationCohortScrubRootTopology(payload, {
      adventurer: 0,
      free: 25,
    });
    if (oneTopology === null) throw new Error("The one-page topology must be valid");
    const child = qualificationCohortScrubRootPartitionPayload(payload, oneTopology, 0);
    if (child === null) throw new Error("The one-page child must be valid");
    const step = new ImmediateRootStep(() => Promise.reject(new Error("unexpected event")));
    const base = {
      inspectArtifacts: () =>
        Promise.resolve({
          _tag: "Present" as const,
          artifactRecordCount: 2,
          lifecycle: "FENCED" as const,
          pendingDeleteScope: null,
          provenDeleteScope: null,
          sealedPageCount: 1,
        }),
      inspectTopology: () => Promise.resolve({ _tag: "Ready" as const, ...oneTopology }),
      inspectFenceArtifacts: () =>
        Promise.resolve({
          _tag: "Present" as const,
          artifactRecordCount: 29,
          lifecycle: "FENCED" as const,
          pendingDeleteScope: null,
          provenDeleteScope: null,
          sealedPageCount: 0,
        }),
      inspectPartitionCompletion: (partition: QualificationCohortScrubPartitionWorkflowPayload) =>
        Promise.resolve({ ...readyPg(partition), deletedArtifactCount: 27 }),
      launchChild: () => Promise.resolve(completedSnapshot(child)),
    };
    await expect(
      runQualificationCohortScrubRoot(
        payload,
        qualificationCohortScrubRootInstanceId(payload.executionId),
        step,
        ports([], {
          ...base,
          inspectPartitionCompletion: () =>
            Promise.resolve({ _tag: "Pending", reason: "partitionPagesIncomplete" }),
        }),
      ),
    ).rejects.toBeInstanceOf(QualificationCohortScrubRootTerminal);
    await expect(
      runQualificationCohortScrubRoot(
        payload,
        qualificationCohortScrubRootInstanceId(payload.executionId),
        step,
        ports([], {
          ...base,
          inspectPartitionCompletion: (input) =>
            Promise.resolve({ ...readyPg(input), deletedArtifactCount: 26 }),
        }),
      ),
    ).rejects.toBeInstanceOf(QualificationCohortScrubRootTerminal);
    const present = {
      _tag: "Present" as const,
      artifactRecordCount: 2,
      lifecycle: "FENCED" as const,
      pendingDeleteScope: null,
      provenDeleteScope: null,
      sealedPageCount: 1,
    };
    await Promise.all(
      [
        {
          ...present,
          lifecycle: "OPEN" as const,
        },
        {
          ...present,
          pendingDeleteScope: "page" as const,
        },
        {
          ...present,
          sealedPageCount: 0,
        },
        {
          ...present,
          artifactRecordCount: 3,
        },
      ].map(
        async (inspection) =>
          await expect(
            runQualificationCohortScrubRoot(
              payload,
              qualificationCohortScrubRootInstanceId(payload.executionId),
              step,
              ports([], { ...base, inspectArtifacts: () => Promise.resolve(inspection) }),
            ),
          ).rejects.toBeInstanceOf(QualificationCohortScrubRootTerminal),
      ),
    );
  });

  it("reconciles an applied child create response loss without restarting", async () => {
    const child = childPayload(0);
    const expectedId = qualificationCohortScrubPartitionInstanceId(
      child.executionId,
      child.partitionIndex,
    );
    const instance = {
      id: expectedId,
      status: () => Promise.resolve({ status: "waiting" as const }),
    };
    await expect(
      createOrReconcileQualificationScrubPartition({
        create: () => Promise.reject(new Error("lost create response")),
        get: () => Promise.resolve(instance),
        id: expectedId,
        params: child,
      }),
    ).resolves.toEqual({ id: expectedId, status: "waiting" });
  });

  it("replays an exact completed two-partition ledger byte-for-byte", async () => {
    const run = () =>
      runQualificationCohortScrubRoot(
        payload,
        qualificationCohortScrubRootInstanceId(payload.executionId),
        new ImmediateRootStep(() => Promise.reject(new Error("unexpected event"))),
        ports([], { launchChild: (child) => Promise.resolve(completedSnapshot(child)) }),
      );
    const first = await run();
    await expect(run()).resolves.toEqual(first);
  });

  it("rejects partial create responses and structural child statuses", async () => {
    const child = childPayload(0);
    const expectedId = qualificationCohortScrubPartitionInstanceId(
      child.executionId,
      child.partitionIndex,
    );
    await expect(
      createOrReconcileQualificationScrubPartition({
        create: () =>
          Promise.resolve({
            id: "wrong",
            status: () => Promise.resolve({ status: "running" as const }),
          }),
        get: () => Promise.reject(new Error("unexpected get")),
        id: expectedId,
        params: child,
      }),
    ).rejects.toBeInstanceOf(QualificationCohortScrubRootTerminal);
    await Promise.all(
      (["errored", "terminated", "paused", "waitingForPause"] as const).map(
        async (status) =>
          await expect(
            runQualificationCohortScrubRoot(
              payload,
              qualificationCohortScrubRootInstanceId(payload.executionId),
              new ImmediateRootStep(() => Promise.reject(new Error("unexpected event"))),
              ports([], {
                launchChild: () => Promise.resolve({ id: expectedId, status }),
              }),
            ),
          ).rejects.toBeInstanceOf(QualificationCohortScrubRootTerminal),
      ),
    );
  });

  it("uses one fixed retry policy for every authority step", () => {
    expect(qualificationCohortScrubRootStepConfig).toEqual({
      retries: { backoff: "constant", delay: "1 minute", limit: 10 },
      timeout: "30 minutes",
    });
  });
});
