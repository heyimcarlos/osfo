/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop, eslint/no-underscore-dangle, osfo/no-unknown-parameters -- Cloudflare Workflow, Durable Object, and PostgreSQL ports are Promise-native tagged boundaries; the runner owns payload decoding and pages must execute in authority order. */
import type { WorkflowStepConfig } from "cloudflare:workers";
import { Data, Schema } from "effect";

import type {
  QualificationScrubPageClaim,
  QualificationScrubPageCompletion,
  QualificationScrubPartitionInspection,
} from "../integrations/postgres/qualification-cohort-scrub";
import { qualificationScrubPageArtifactIds } from "../integrations/postgres/qualification-cohort-scrub";
import type {
  QualificationCohortArtifactDeleteOutcome,
  QualificationCohortArtifactSealPageOutcome,
} from "../qualification/cohort-artifact-authority-contract";
import { qualificationCohortArtifactProtocol } from "../qualification/cohort-artifact-authority-contract";
import { qualificationChecksum } from "../qualification/qualification-checksum";
import {
  decodeQualificationCohortScrubPartitionWorkflowPayload,
  qualificationCohortScrubPageClaimToken,
  qualificationCohortScrubPartitionInstanceId,
  qualificationCohortScrubPartitionRetryDelay,
  qualificationCohortScrubPartitionRetryLimit,
  qualificationCohortScrubPartitionStepTimeout,
  qualificationCohortScrubPartitionWake,
  type QualificationCohortScrubPageTopology,
  type QualificationCohortScrubPartitionTopology,
  type QualificationCohortScrubPartitionWorkflowPayload,
} from "../qualification/cohort-scrub-partition";

export const qualificationCohortScrubPartitionStepConfig = {
  retries: {
    backoff: "constant",
    delay: qualificationCohortScrubPartitionRetryDelay,
    limit: qualificationCohortScrubPartitionRetryLimit,
  },
  timeout: qualificationCohortScrubPartitionStepTimeout,
} as const satisfies WorkflowStepConfig;

const PageStepResult = Schema.Struct({
  pageChecksum: Schema.String.check(Schema.isMinLength(1)),
  pageIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  plan: Schema.Literals(["adventurer", "free"]),
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  proofChecksum: Schema.String.check(Schema.isMinLength(1)),
});
export type QualificationCohortScrubPartitionPageResult = typeof PageStepResult.Type;

const PartitionResult = Schema.Struct({
  cohortId: Schema.String,
  executionId: Schema.String,
  firstPagePosition: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pageCount: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(32)),
  partitionIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  terminalPageChecksum: Schema.String.check(Schema.isMinLength(1)),
  wake: Schema.Struct({
    eventId: Schema.String,
    eventType: Schema.Literal("qualification-cohort-scrub-partition-complete-v1"),
    rootCoordinatorInstanceId: Schema.String,
  }),
});
export type QualificationCohortScrubPartitionResult = typeof PartitionResult.Type;

export interface QualificationCohortScrubPartitionStep {
  readonly do: <Value extends Rpc.Serializable<Value>>(
    name: string,
    config: WorkflowStepConfig,
    callback: (context: { readonly attempt: number }) => Promise<Value>,
  ) => Promise<Value>;
}

export interface QualificationCohortScrubPageAuthority {
  readonly claim: (
    claimToken: string,
    page: QualificationCohortScrubPageTopology,
  ) => Promise<QualificationScrubPageClaim>;
  readonly complete: (input: {
    readonly artifactAuthorityProofChecksum: string;
    readonly claimToken: string;
    readonly deletedArtifactCount: number;
    readonly deletedArtifactsChecksum: string;
    readonly pageIndex: number;
    readonly plan: "adventurer" | "free";
  }) => Promise<QualificationScrubPageCompletion>;
  readonly deletePage: (input: {
    readonly executionId: string;
    readonly expectedArtifactKeys: ReadonlyArray<string>;
    readonly expectedArtifactsChecksum: string;
    readonly pageIndex: number;
    readonly plan: "adventurer" | "free";
    readonly position: number;
    readonly previousPageChecksum: string;
    readonly protocolVersion: typeof qualificationCohortArtifactProtocol;
  }) => Promise<QualificationCohortArtifactDeleteOutcome>;
  readonly sealPage: (input: {
    readonly executionId: string;
    readonly expectedArtifactKeys: ReadonlyArray<string>;
    readonly expectedArtifactsChecksum: string;
    readonly pageChecksum: string;
    readonly pageIndex: number;
    readonly plan: "adventurer" | "free";
    readonly position: number;
    readonly previousPageChecksum: string;
    readonly proofChecksum: string;
    readonly protocolVersion: typeof qualificationCohortArtifactProtocol;
  }) => Promise<QualificationCohortArtifactSealPageOutcome>;
}

export interface QualificationCohortScrubPartitionPorts {
  readonly inspectTopology: (
    payload: QualificationCohortScrubPartitionWorkflowPayload,
  ) => Promise<QualificationScrubPartitionInspection>;
  readonly withPageAuthority: <Value>(
    evaluate: (authority: QualificationCohortScrubPageAuthority) => Promise<Value>,
  ) => Promise<Value>;
}

export class QualificationCohortScrubPartitionRetryable extends Data.TaggedError(
  "QualificationCohortScrubPartitionRetryable",
)<{ readonly message: string }> {}
export class QualificationCohortScrubPartitionTerminal extends Data.TaggedError(
  "QualificationCohortScrubPartitionTerminal",
)<{ readonly message: string }> {}

const retryable = (message: string): never => {
  throw new QualificationCohortScrubPartitionRetryable({ message });
};

const terminal = (message: string): never => {
  throw new QualificationCohortScrubPartitionTerminal({ message });
};

const exactPageArtifacts = (
  payload: QualificationCohortScrubPartitionWorkflowPayload,
  topology: QualificationCohortScrubPartitionTopology,
  page: QualificationCohortScrubPageTopology,
  claim: Extract<QualificationScrubPageClaim, { readonly _tag: "Claimed" | "Completed" }>,
) => {
  if (
    claim.cohortId !== payload.cohortId ||
    claim.executionId !== payload.executionId ||
    claim.plan !== page.plan ||
    claim.pageIndex !== page.pageIndex ||
    claim.firstParticipantIndex !== page.pageIndex * 25 ||
    claim.participantCount <= 0 ||
    claim.participantCount > 25
  ) {
    return null;
  }
  const keys = qualificationScrubPageArtifactIds(
    payload.executionId,
    page.plan,
    claim.firstParticipantIndex,
    claim.participantCount,
    topology.freeParticipantCount,
    page.pageIndex,
  );
  return keys.length === claim.expectedArtifactCount &&
    qualificationChecksum({ expectedArtifactIds: keys }) === claim.expectedArtifactsChecksum
    ? keys
    : null;
};

const sealExactPage = async (
  authority: QualificationCohortScrubPageAuthority,
  input: {
    readonly executionId: string;
    readonly expectedArtifactKeys: ReadonlyArray<string>;
    readonly expectedArtifactsChecksum: string;
    readonly pageChecksum: string;
    readonly pageIndex: number;
    readonly plan: "adventurer" | "free";
    readonly position: number;
    readonly previousPageChecksum: string;
    readonly proofChecksum: string;
  },
): Promise<QualificationCohortScrubPartitionPageResult> => {
  const sealed = await authority.sealPage({
    ...input,
    protocolVersion: qualificationCohortArtifactProtocol,
  });
  if (sealed._tag === "Busy") return retryable("artifact authority is busy while sealing page");
  if (sealed._tag === "Missing") return terminal(`artifact seal authority missing: ${sealed.code}`);
  if (sealed._tag === "Conflict") {
    return terminal(`artifact seal authority conflicts: ${sealed.code}`);
  }
  if (
    sealed.pageChecksum !== input.pageChecksum ||
    sealed.position !== input.position ||
    sealed.proofChecksum !== input.proofChecksum
  ) {
    return terminal("artifact seal authority returned a substituted page");
  }
  return {
    pageChecksum: sealed.pageChecksum,
    pageIndex: input.pageIndex,
    plan: input.plan,
    position: sealed.position,
    proofChecksum: sealed.proofChecksum,
  };
};

export const advanceQualificationCohortScrubPage = async (
  authority: QualificationCohortScrubPageAuthority,
  payload: QualificationCohortScrubPartitionWorkflowPayload,
  topology: QualificationCohortScrubPartitionTopology,
  page: QualificationCohortScrubPageTopology,
  attempt: number,
): Promise<QualificationCohortScrubPartitionPageResult> => {
  if (!Number.isSafeInteger(attempt) || attempt <= 0) return terminal("invalid Workflow attempt");
  const claimToken = qualificationCohortScrubPageClaimToken(payload, page.position, attempt);
  const claim = await authority.claim(claimToken, page);
  if (claim._tag === "Busy" || claim._tag === "LeaseExpired") {
    return retryable(`PostgreSQL page claim is ${claim._tag}`);
  }
  if (claim._tag === "Pending")
    return terminal(`PostgreSQL page authority missing: ${claim.reason}`);
  if (claim._tag === "Conflict") return terminal("PostgreSQL page authority conflicts");
  const keys = exactPageArtifacts(payload, topology, page, claim);
  if (keys === null) return terminal("PostgreSQL page descriptor conflicts with topology");
  if (claim._tag === "Completed") {
    if (claim.pageChecksum.length === 0 || claim.artifactAuthorityProofChecksum.length === 0) {
      return terminal("completed PostgreSQL page authority is incomplete");
    }
    return await sealExactPage(authority, {
      executionId: payload.executionId,
      expectedArtifactKeys: keys,
      expectedArtifactsChecksum: claim.expectedArtifactsChecksum,
      pageChecksum: claim.pageChecksum,
      pageIndex: page.pageIndex,
      plan: page.plan,
      position: page.position,
      previousPageChecksum: claim.previousPageChecksum,
      proofChecksum: claim.artifactAuthorityProofChecksum,
    });
  }
  const deleted = await authority.deletePage({
    executionId: payload.executionId,
    expectedArtifactKeys: keys,
    expectedArtifactsChecksum: claim.expectedArtifactsChecksum,
    pageIndex: page.pageIndex,
    plan: page.plan,
    position: page.position,
    previousPageChecksum: claim.previousPageChecksum,
    protocolVersion: qualificationCohortArtifactProtocol,
  });
  if (deleted._tag === "Busy" || deleted._tag === "Retryable") {
    return retryable(`artifact deletion is ${deleted._tag}`);
  }
  if (deleted._tag === "Missing")
    return terminal(`artifact deletion authority missing: ${deleted.code}`);
  if (deleted._tag === "Conflict") {
    return terminal(`artifact deletion authority conflicts: ${deleted.code}`);
  }
  if (
    deleted.expectedArtifactCount !== claim.expectedArtifactCount ||
    deleted.expectedArtifactsChecksum !== claim.expectedArtifactsChecksum ||
    deleted.proofChecksum.length === 0
  ) {
    return terminal("artifact deletion proof conflicts with PostgreSQL authority");
  }
  const completed = await authority.complete({
    artifactAuthorityProofChecksum: deleted.proofChecksum,
    claimToken,
    deletedArtifactCount: deleted.expectedArtifactCount,
    deletedArtifactsChecksum: deleted.expectedArtifactsChecksum,
    pageIndex: page.pageIndex,
    plan: page.plan,
  });
  if (completed._tag === "Conflict") return terminal("PostgreSQL page completion conflicts");
  if (
    completed.artifactAuthorityProofChecksum !== deleted.proofChecksum ||
    completed.previousPageChecksum !== claim.previousPageChecksum ||
    completed.pageChecksum.length === 0
  ) {
    return terminal("PostgreSQL page completion substituted authority");
  }
  return await sealExactPage(authority, {
    executionId: payload.executionId,
    expectedArtifactKeys: keys,
    expectedArtifactsChecksum: claim.expectedArtifactsChecksum,
    pageChecksum: completed.pageChecksum,
    pageIndex: page.pageIndex,
    plan: page.plan,
    position: page.position,
    previousPageChecksum: completed.previousPageChecksum,
    proofChecksum: completed.artifactAuthorityProofChecksum,
  });
};

export const runQualificationCohortScrubPartition = async (
  input: unknown,
  instanceId: string,
  step: QualificationCohortScrubPartitionStep,
  ports: QualificationCohortScrubPartitionPorts,
  terminalError: (message: string) => Error = (message) =>
    new QualificationCohortScrubPartitionTerminal({ message }),
): Promise<QualificationCohortScrubPartitionResult> => {
  const payload = decodeQualificationCohortScrubPartitionWorkflowPayload(input);
  if (
    payload === null ||
    instanceId !==
      qualificationCohortScrubPartitionInstanceId(payload.executionId, payload.partitionIndex)
  ) {
    throw terminalError("invalid qualification cohort scrub partition invocation");
  }
  const inspected = await step.do(
    "authenticate cohort scrub partition topology",
    qualificationCohortScrubPartitionStepConfig,
    () => ports.inspectTopology(payload),
  );
  if (inspected._tag === "Pending") {
    throw terminalError(`qualification cohort scrub partition missing: ${inspected.reason}`);
  }
  if (inspected._tag === "Conflict") {
    throw terminalError("qualification cohort scrub partition topology conflicts");
  }
  const pageResults = new Array<QualificationCohortScrubPartitionPageResult>();
  for (const page of inspected.pages) {
    const result = await step.do(
      `scrub cohort artifact page ${String(page.position).padStart(4, "0")}`,
      qualificationCohortScrubPartitionStepConfig,
      async (context) => {
        try {
          return await ports.withPageAuthority((authority) =>
            advanceQualificationCohortScrubPage(
              authority,
              payload,
              inspected,
              page,
              context.attempt,
            ),
          );
        } catch (error) {
          if (error instanceof QualificationCohortScrubPartitionTerminal) {
            throw terminalError(error.message);
          }
          throw error;
        }
      },
    );
    pageResults.push(Schema.decodeSync(PageStepResult)(result));
  }
  const terminalPage = pageResults.at(-1);
  if (terminalPage === undefined) throw terminalError("qualification scrub partition has no pages");
  return Schema.decodeSync(PartitionResult)({
    cohortId: payload.cohortId,
    executionId: payload.executionId,
    firstPagePosition: inspected.firstPagePosition,
    pageCount: inspected.pageCount,
    partitionIndex: payload.partitionIndex,
    terminalPageChecksum: terminalPage.pageChecksum,
    wake: qualificationCohortScrubPartitionWake(payload),
  });
};
