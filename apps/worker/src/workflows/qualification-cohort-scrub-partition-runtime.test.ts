/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, eslint/no-await-in-loop, eslint/no-underscore-dangle -- Promise/Date fakes model Cloudflare Workflow, Durable Object, and PostgreSQL boundaries; cases intentionally run sequentially. */
import { describe, expect, it } from "vitest";
import type { WorkflowStepConfig } from "cloudflare:workers";

import { qualificationScrubPageArtifactIds } from "../integrations/postgres/qualification-cohort-scrub";
import { qualificationChecksum } from "../qualification/qualification-checksum";
import {
  qualificationCohortScrubPartitionInstanceId,
  qualificationCohortScrubPartitionProtocol,
  qualificationCohortScrubPartitionTopology,
  type QualificationCohortScrubPartitionWorkflowPayload,
} from "../qualification/cohort-scrub-partition";
import {
  advanceQualificationCohortScrubPage,
  QualificationCohortScrubPartitionRetryable,
  QualificationCohortScrubPartitionTerminal,
  qualificationCohortScrubPartitionStepConfig,
  runQualificationCohortScrubPartition,
  type QualificationCohortScrubPageAuthority,
  type QualificationCohortScrubPartitionStep,
} from "./qualification-cohort-scrub-partition-runtime";

const payload: QualificationCohortScrubPartitionWorkflowPayload = {
  cohortId: "scrub-cohort",
  executionId: "scrub-execution",
  firstPagePosition: 0,
  pageCount: 1,
  partitionIndex: 0,
  protocolVersion: qualificationCohortScrubPartitionProtocol,
  rootCoordinatorInstanceId: "scrub-root",
};
const topology = qualificationCohortScrubPartitionTopology(payload, {
  adventurer: 0,
  free: 1,
});
if (topology === null) throw new Error("The scrub topology fixture must be valid");
const page = topology.pages[0];
if (page === undefined) throw new Error("The scrub topology fixture must contain one page");
const keys = qualificationScrubPageArtifactIds(payload.executionId, "free", 0, 1, 1, 0);
const expectedArtifactsChecksum = qualificationChecksum({ expectedArtifactIds: keys });

const claimed = (claimToken: string) =>
  ({
    _tag: "Claimed",
    claimToken,
    cohortId: payload.cohortId,
    deletionReceiptsChecksum: "deletion-receipts",
    executionId: payload.executionId,
    expectedArtifactCount: keys.length,
    expectedArtifactIds: keys,
    expectedArtifactsChecksum,
    firstParticipantIndex: 0,
    leaseExpiresAt: new Date("2099-08-30T17:05:00.000Z"),
    pageIndex: 0,
    participantCount: 1,
    plan: "free",
    previousPageChecksum: "NONE",
  }) as const;

const completedClaim = (claimToken: string) =>
  ({
    ...claimed(claimToken),
    _tag: "Completed",
    artifactAuthorityProofChecksum: "proof",
    pageChecksum: "page-checksum",
  }) as const;

const proven = {
  _tag: "Proven",
  artifactRecordsChecksum: "records",
  expectedArtifactCount: keys.length,
  expectedArtifactsChecksum,
  operationId: "operation",
  proofChecksum: "proof",
  scope: "page",
} as const;

const pageCompletion = {
  _tag: "Completed",
  artifactAuthorityProofChecksum: "proof",
  completedAt: new Date("2099-08-30T17:00:00.000Z"),
  pageChecksum: "page-checksum",
  previousPageChecksum: "NONE",
} as const;

const sealed = {
  _tag: "Sealed",
  pageChecksum: "page-checksum",
  position: 0,
  proofChecksum: "proof",
} as const;

const authority = (
  calls: Array<string>,
  overrides: Partial<QualificationCohortScrubPageAuthority> = {},
): QualificationCohortScrubPageAuthority => ({
  claim: (claimToken) => {
    calls.push("claim");
    return Promise.resolve(claimed(claimToken));
  },
  complete: () => {
    calls.push("complete");
    return Promise.resolve(pageCompletion);
  },
  deletePage: () => {
    calls.push("delete");
    return Promise.resolve(proven);
  },
  sealPage: () => {
    calls.push("seal");
    return Promise.resolve(sealed);
  },
  ...overrides,
});

class ImmediateStep implements QualificationCohortScrubPartitionStep {
  readonly calls = new Array<{
    readonly attempt: number;
    readonly config: WorkflowStepConfig;
    readonly name: string;
  }>();
  constructor(readonly attempt = 1) {}

  do<Value extends Rpc.Serializable<Value>>(
    name: string,
    config: WorkflowStepConfig,
    callback: (context: { readonly attempt: number }) => Promise<Value>,
  ): Promise<Value> {
    this.calls.push({ attempt: this.attempt, config, name });
    return callback({ attempt: this.attempt });
  }
}

describe("qualification cohort scrub partition runtime", () => {
  it("runs the exact durable page order and returns only a deterministic wake descriptor", async () => {
    const calls = new Array<string>();
    const step = new ImmediateStep();
    const result = await runQualificationCohortScrubPartition(
      payload,
      qualificationCohortScrubPartitionInstanceId(payload.executionId, payload.partitionIndex),
      step,
      {
        inspectTopology: () => {
          calls.push("inspect");
          return Promise.resolve({ _tag: "Ready", ...topology });
        },
        withPageAuthority: (evaluate) => evaluate(authority(calls)),
      },
    );

    expect(calls).toEqual(["inspect", "claim", "delete", "complete", "seal"]);
    expect(step.calls.map(({ name }) => name)).toEqual([
      "authenticate cohort scrub partition topology",
      "scrub cohort artifact page 0000",
    ]);
    expect(
      step.calls.every(({ config }) => config === qualificationCohortScrubPartitionStepConfig),
    ).toBe(true);
    expect(result).toMatchObject({
      firstPagePosition: 0,
      pageCount: 1,
      terminalPageChecksum: "page-checksum",
      wake: {
        eventType: "qualification-cohort-scrub-partition-complete-v1",
        rootCoordinatorInstanceId: payload.rootCoordinatorInstanceId,
      },
    });
  });

  it("advances all 32 pages sequentially with an exact predecessor checksum chain", async () => {
    const fullPayload = { ...payload, pageCount: 32 };
    const fullTopology = qualificationCohortScrubPartitionTopology(fullPayload, {
      adventurer: 0,
      free: 800,
    });
    if (fullTopology === null) throw new Error("The full partition fixture must be valid");
    let currentPosition = 0;
    let currentClaimToken = "";
    let currentExpectedChecksum = "";
    let currentExpectedCount = 0;
    let currentPreviousChecksum = "NONE";
    const pageAuthority: QualificationCohortScrubPageAuthority = {
      claim: (claimToken, currentPage) => {
        expect(currentPage.position).toBe(currentPosition);
        currentClaimToken = claimToken;
        const artifactKeys = qualificationScrubPageArtifactIds(
          fullPayload.executionId,
          currentPage.plan,
          currentPage.pageIndex * 25,
          25,
          800,
          currentPage.pageIndex,
        );
        currentExpectedChecksum = qualificationChecksum({ expectedArtifactIds: artifactKeys });
        currentExpectedCount = artifactKeys.length;
        currentPreviousChecksum = currentPosition === 0 ? "NONE" : `page-${currentPosition - 1}`;
        return Promise.resolve({
          _tag: "Claimed" as const,
          claimToken,
          cohortId: fullPayload.cohortId,
          deletionReceiptsChecksum: `deletions-${currentPosition}`,
          executionId: fullPayload.executionId,
          expectedArtifactCount: artifactKeys.length,
          expectedArtifactIds: artifactKeys,
          expectedArtifactsChecksum: currentExpectedChecksum,
          firstParticipantIndex: currentPage.pageIndex * 25,
          leaseExpiresAt: new Date("2099-08-30T17:05:00.000Z"),
          pageIndex: currentPage.pageIndex,
          participantCount: 25,
          plan: currentPage.plan,
          previousPageChecksum: currentPreviousChecksum,
        });
      },
      complete: (input) => {
        expect(input.claimToken).toBe(currentClaimToken);
        return Promise.resolve({
          _tag: "Completed" as const,
          artifactAuthorityProofChecksum: `proof-${currentPosition}`,
          completedAt: new Date("2099-08-30T17:00:00.000Z"),
          pageChecksum: `page-${currentPosition}`,
          previousPageChecksum: currentPreviousChecksum,
        });
      },
      deletePage: (input) => {
        expect(input.previousPageChecksum).toBe(currentPreviousChecksum);
        return Promise.resolve({
          _tag: "Proven" as const,
          artifactRecordsChecksum: `records-${currentPosition}`,
          expectedArtifactCount: currentExpectedCount,
          expectedArtifactsChecksum: currentExpectedChecksum,
          operationId: `operation-${currentPosition}`,
          proofChecksum: `proof-${currentPosition}`,
          scope: "page" as const,
        });
      },
      sealPage: (input) => {
        expect(input.position).toBe(currentPosition);
        const outcome = {
          _tag: "Sealed" as const,
          pageChecksum: `page-${currentPosition}`,
          position: currentPosition,
          proofChecksum: `proof-${currentPosition}`,
        };
        currentPosition += 1;
        return Promise.resolve(outcome);
      },
    };

    const step = new ImmediateStep();
    const result = await runQualificationCohortScrubPartition(
      fullPayload,
      qualificationCohortScrubPartitionInstanceId(fullPayload.executionId, 0),
      step,
      {
        inspectTopology: () => Promise.resolve({ _tag: "Ready", ...fullTopology }),
        withPageAuthority: (evaluate) => evaluate(pageAuthority),
      },
    );

    expect(currentPosition).toBe(32);
    expect(step.calls).toHaveLength(33);
    expect(result.terminalPageChecksum).toBe("page-31");
  });

  it("replays a durable DO proof after response loss before PostgreSQL completion", async () => {
    const calls = new Array<string>();
    let proofPersisted = false;
    let first = true;
    const port = authority(calls, {
      deletePage: () => {
        calls.push("delete");
        proofPersisted = true;
        if (first) {
          first = false;
          return Promise.reject(new Error("lost delete response"));
        }
        return Promise.resolve(proven);
      },
    });

    await expect(
      advanceQualificationCohortScrubPage(port, payload, topology, page, 1),
    ).rejects.toThrow("lost delete response");
    expect(proofPersisted).toBe(true);
    await expect(
      advanceQualificationCohortScrubPage(port, payload, topology, page, 2),
    ).resolves.toMatchObject({ pageChecksum: "page-checksum" });
    expect(calls).toEqual(["claim", "delete", "claim", "delete", "complete", "seal"]);
  });

  it("replays seal after PostgreSQL completion and after a lost seal response", async () => {
    for (const sealAppliedBeforeThrow of [false, true]) {
      const calls = new Array<string>();
      let persistedPg = false;
      let persistedSeal = false;
      let firstSeal = true;
      const port = authority(calls, {
        claim: (claimToken) => {
          calls.push("claim");
          return Promise.resolve(persistedPg ? completedClaim(claimToken) : claimed(claimToken));
        },
        complete: () => {
          calls.push("complete");
          persistedPg = true;
          return Promise.resolve(pageCompletion);
        },
        sealPage: () => {
          calls.push("seal");
          if (firstSeal) {
            firstSeal = false;
            persistedSeal = sealAppliedBeforeThrow;
            return Promise.reject(new Error("lost seal response"));
          }
          persistedSeal = true;
          return Promise.resolve(sealed);
        },
      });

      await expect(
        advanceQualificationCohortScrubPage(port, payload, topology, page, 1),
      ).rejects.toThrow("lost seal response");
      expect(persistedPg).toBe(true);
      await expect(
        advanceQualificationCohortScrubPage(port, payload, topology, page, 2),
      ).resolves.toEqual({
        pageChecksum: "page-checksum",
        pageIndex: 0,
        plan: "free",
        position: 0,
        proofChecksum: "proof",
      });
      expect(persistedSeal).toBe(true);
      expect(calls).toEqual(["claim", "delete", "complete", "seal", "claim", "seal"]);
    }
  });

  it("retries lease, busy, unavailable, and survivor outcomes", async () => {
    for (const claim of [
      { _tag: "Busy", leaseExpiresAt: new Date("2099-08-30T17:05:00.000Z") } as const,
      { _tag: "LeaseExpired", leaseExpiresAt: new Date("2099-08-30T17:00:00.000Z") } as const,
    ]) {
      await expect(
        advanceQualificationCohortScrubPage(
          authority([], { claim: () => Promise.resolve(claim) }),
          payload,
          topology,
          page,
          2,
        ),
      ).rejects.toBeInstanceOf(QualificationCohortScrubPartitionRetryable);
    }
    for (const deleted of [
      { _tag: "Busy" } as const,
      {
        _tag: "Retryable",
        operationId: "operation",
        survivingArtifactCount: 1,
        survivingArtifactsChecksum: "survivors",
      } as const,
    ]) {
      await expect(
        advanceQualificationCohortScrubPage(
          authority([], { deletePage: () => Promise.resolve(deleted) }),
          payload,
          topology,
          page,
          2,
        ),
      ).rejects.toBeInstanceOf(QualificationCohortScrubPartitionRetryable);
    }
    await expect(
      advanceQualificationCohortScrubPage(
        authority([], { sealPage: () => Promise.resolve({ _tag: "Busy" }) }),
        payload,
        topology,
        page,
        2,
      ),
    ).rejects.toBeInstanceOf(QualificationCohortScrubPartitionRetryable);
    await expect(
      advanceQualificationCohortScrubPage(
        authority([], { claim: () => Promise.reject(new Error("postgres unavailable")) }),
        payload,
        topology,
        page,
        2,
      ),
    ).rejects.toThrow("postgres unavailable");
  });

  it("changes the claim token when a new attempt reclaims an expired same-token lease", async () => {
    const tokens = new Array<string>();
    let leaseExpired = true;
    const port = authority([], {
      claim: (claimToken) => {
        tokens.push(claimToken);
        if (leaseExpired) {
          leaseExpired = false;
          return Promise.resolve({
            _tag: "LeaseExpired" as const,
            leaseExpiresAt: new Date("2099-08-30T17:00:00.000Z"),
          });
        }
        return Promise.resolve(claimed(claimToken));
      },
    });

    await expect(
      advanceQualificationCohortScrubPage(port, payload, topology, page, 4),
    ).rejects.toBeInstanceOf(QualificationCohortScrubPartitionRetryable);
    await expect(
      advanceQualificationCohortScrubPage(port, payload, topology, page, 5),
    ).resolves.toMatchObject({ pageChecksum: "page-checksum" });
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).not.toBe(tokens[0]);
  });

  it("fails terminally on structural missing, conflict, and substituted authority", async () => {
    for (const claim of [
      { _tag: "Conflict" } as const,
      { _tag: "Pending", reason: "previousPageIncomplete" } as const,
    ]) {
      await expect(
        advanceQualificationCohortScrubPage(
          authority([], { claim: () => Promise.resolve(claim) }),
          payload,
          topology,
          page,
          1,
        ),
      ).rejects.toBeInstanceOf(QualificationCohortScrubPartitionTerminal);
    }
    await expect(
      advanceQualificationCohortScrubPage(
        authority([], {
          claim: (claimToken) =>
            Promise.resolve({ ...claimed(claimToken), executionId: "foreign-execution" }),
        }),
        payload,
        topology,
        page,
        1,
      ),
    ).rejects.toBeInstanceOf(QualificationCohortScrubPartitionTerminal);
    for (const deleted of [
      { _tag: "Missing", code: "authorityNotFenced" } as const,
      { _tag: "Conflict", code: "deleteIntentConflict" } as const,
    ]) {
      await expect(
        advanceQualificationCohortScrubPage(
          authority([], { deletePage: () => Promise.resolve(deleted) }),
          payload,
          topology,
          page,
          1,
        ),
      ).rejects.toBeInstanceOf(QualificationCohortScrubPartitionTerminal);
    }
    await expect(
      advanceQualificationCohortScrubPage(
        authority([], { complete: () => Promise.resolve({ _tag: "Conflict" }) }),
        payload,
        topology,
        page,
        1,
      ),
    ).rejects.toBeInstanceOf(QualificationCohortScrubPartitionTerminal);
    await expect(
      advanceQualificationCohortScrubPage(
        authority([], {
          claim: (claimToken) => Promise.resolve(completedClaim(claimToken)),
          sealPage: () => Promise.resolve({ _tag: "Missing", code: "proofMissing" }),
        }),
        payload,
        topology,
        page,
        1,
      ),
    ).rejects.toBeInstanceOf(QualificationCohortScrubPartitionTerminal);
  });

  it("makes duplicate completion wake descriptors harmless and non-authoritative", async () => {
    const run = () =>
      runQualificationCohortScrubPartition(
        payload,
        qualificationCohortScrubPartitionInstanceId(payload.executionId, payload.partitionIndex),
        new ImmediateStep(2),
        {
          inspectTopology: () => Promise.resolve({ _tag: "Ready", ...topology }),
          withPageAuthority: (evaluate) =>
            evaluate(
              authority([], {
                claim: (claimToken) => Promise.resolve(completedClaim(claimToken)),
              }),
            ),
        },
      );
    const first = await run();
    const replay = await run();
    expect(replay).toEqual(first);
    expect(replay.wake).toEqual(first.wake);
  });
});
