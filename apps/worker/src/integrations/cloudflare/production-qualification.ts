import { Data, Effect, Option, Schema } from "effect";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { CostSummaryEvidence } from "../../qualification/cost-evidence";
import type {
  QualificationExecutionArtifactStore,
  QualificationExecutionPlan,
} from "../../qualification/execution";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../../qualification/qualification-checksum";
import type { ProductionQualificationManifest } from "../../qualification/qualification-manifest";
import { qualificationAuthoritySources } from "../../qualification/authority-sources";
import {
  decodeQualificationCohortManifest,
  qualificationCohortArtifactId,
  type QualificationCohortManifest,
} from "../../qualification/qualification-cohort";
import {
  unavailableProductionQualificationReport,
  type ProductionQualificationReport,
} from "../../qualification/production-qualification";
import { qualificationOwnerDimensionCoordinatorBudget } from "../../qualification/owner-partitions";
import {
  makeQualificationExecutionArtifactStore,
  type QualificationExecutionArtifactUnavailable,
  type QualificationExecutionListingBucket,
} from "./qualification-execution-artifacts";
import {
  authenticateQualificationDistributedCorrectnessReference,
  authenticateQualificationDistributedDimensionReference,
  authenticateQualificationDistributedEvaluationReport,
  authenticateQualificationDistributedEvaluationReportCompletion,
} from "../../workflows/qualification-owner-report";

const authorityStreamComponents = [
  "arrivals",
  "cost",
  "externalGates",
  "faults",
  "memorySemantic",
  "recovery",
  "resourceUse",
  "runs",
  "semantic",
  "stages",
] as const;
type AuthorityStreamComponent = (typeof authorityStreamComponents)[number];

const costDimensions = [
  "acceptedMessage",
  "betaMonth",
  "growthDepthMonth",
  "growthWidthMonth",
  "publicMonth",
  "planPeriod:adventurer",
  "planPeriod:free",
  "goodRootOutcome:accountBillingSafetyDataRights",
  "goodRootOutcome:documentBuild",
  "goodRootOutcome:fileAnalysis",
  "goodRootOutcome:gmail",
  "goodRootOutcome:ordinaryConversation",
  "goodRootOutcome:registration",
  "goodRootOutcome:reminder",
  "goodRootOutcome:researchReport",
  "goodRootOutcome:scheduledEmail",
] as const satisfies ReadonlyArray<CostSummaryEvidence["dimension"]>;
const stageLanes = ["allCold", "dependencyOutageRecovery", "stress", "target"] as const;
const stageRegions = ["americas", "asiaPacific", "europe"] as const;
const stageNames = [
  "coldDurableAcceptance",
  "combinedLiveAdmission",
  "firstDeliveryAttempt",
  "firstMeaningfulUserUpdate",
  "scheduledEmailOutcome",
  "scheduledEmailProtectedSendStart",
  "scheduledTaskHandlerStart",
  "scheduledTaskSubmissionAcceptance",
  "warmDurableAcceptance",
  "workflowOutcomeFollowUpAcceptance",
  "workflowStartAcceptance",
  "workflowWakeMilestoneCommit",
] as const;
const coldCauses = ["deployment", "faultRecovery", "firstUse", "idleEviction"] as const;
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const OwnerStreamDescriptor = Schema.Struct({
  artifactPrefix: Schema.String,
  canonicalDigest: Schema.String,
  chunkCount: NonNegativeInteger,
  component: Schema.Literals(authorityStreamComponents),
  recordCount: NonNegativeInteger,
  sourceVersion: Schema.String,
  terminalChecksum: Schema.String,
  verificationVersion: Schema.Literal("qualification-owner-stream-v1"),
});
const ProductAuthorityStreamDescriptor = Schema.Struct({
  artifactPrefix: Schema.String,
  chunkCount: NonNegativeInteger,
  recordCount: NonNegativeInteger,
  source: Schema.Literals(qualificationAuthoritySources),
  terminalChecksum: Schema.String,
});
const OwnerBundleDescriptor = Schema.Struct({
  artifactChecksum: Schema.String,
  authoritySources: Schema.Array(Schema.String),
  evaluatorVersion: Schema.Literal("production-qualification-v1"),
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  ownerIdentity: Schema.Literal("osfo-qualification-owner-v1"),
  planChecksum: Schema.String,
  productAuthorityStreams: Schema.Array(ProductAuthorityStreamDescriptor),
  reportArtifactChecksum: Schema.String,
  reportArtifactId: Schema.String,
  streams: Schema.Array(OwnerStreamDescriptor),
});
const OwnerResponse = Schema.Struct({
  bundleArtifactChecksum: Schema.String,
  bundleArtifactId: Schema.String,
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
});
const OwnerMissingResponse = Schema.Struct({
  error: Schema.Literal("qualificationAuthorityMaterialMissing"),
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  missingSources: Schema.Array(Schema.String),
  planChecksum: Schema.String,
  verdict: Schema.Literal("MISSING"),
});
const OwnerFailedResponse = Schema.Struct({
  error: Schema.Literal("qualificationAuthorityConflict"),
  executionId: Schema.String,
  failureCodes: Schema.Array(Schema.String),
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
  verdict: Schema.Literal("FAIL"),
});
const OwnerDistributedEvaluationResponse = Schema.Struct({
  completionArtifactId: Schema.String,
  completionChecksum: Schema.String,
  error: Schema.Literals([
    "qualificationAuthorityConflict",
    "qualificationAuthorityMaterialMissing",
  ]),
  executionId: Schema.String,
  failingFamilies: Schema.Array(Schema.String),
  manifestChecksum: Schema.String,
  missingFamilies: Schema.Array(Schema.String),
  phase: Schema.Literal("PRE_TEARDOWN"),
  planChecksum: Schema.String,
  reportArtifactId: Schema.String,
  reportChecksum: Schema.String,
  verdict: Schema.Literals(["FAIL", "MISSING"]),
  version: Schema.Literal("qualification-owner-response-v2"),
});
const OwnerLegacyTerminalResponse = Schema.Union([OwnerMissingResponse, OwnerFailedResponse]);
const OwnerReport = Schema.Struct({
  adventurerContributionMargin: Schema.NullOr(Schema.Finite),
  costSummaries: Schema.Array(
    Schema.Struct({
      denominator: NonNegativeInteger,
      dimension: Schema.Literals(costDimensions),
      totalUsdMicros: Schema.String,
    }),
  ),
  evaluationInputChecksum: Schema.String,
  executionId: Schema.String,
  findings: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      detail: Schema.String,
      subject: Schema.String,
      verdict: Schema.Literals(["FAIL", "MISSING"]),
    }),
  ),
  foreignExchangeUsdMicros: Schema.String,
  freeCostPerActivePeriodUsdMicros: Schema.NullOr(Schema.String),
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
  recoveryReservePerSecond: Schema.NullOr(Schema.Finite),
  stageSummaries: Schema.Array(
    Schema.Struct({
      coldCause: Schema.optionalKey(Schema.Literals(coldCauses)),
      lane: Schema.Literals(stageLanes),
      maximumLatencyMs: Schema.Finite,
      maximumObservedLatencyMs: Schema.Finite,
      p50LatencyMs: Schema.Finite,
      p95LatencyMs: Schema.Finite,
      p99LatencyMs: Schema.Finite,
      region: Schema.Literals(stageRegions),
      repetition: NonNegativeInteger,
      sampleCount: NonNegativeInteger,
      stage: Schema.Literals(stageNames),
      withinObjectiveRatio: Schema.Finite,
    }),
  ),
  taxesUsdMicros: Schema.String,
  verdict: Schema.Literals(["FAIL", "MISSING", "PASS"]),
});
const AuthorityShardMetadata = Schema.Struct({
  "osfo-artifact-checksum": Schema.String,
  "osfo-body-sha256": Schema.String,
  "osfo-component": Schema.Literals(authorityStreamComponents),
  "osfo-execution-id": Schema.String,
  "osfo-index": Schema.String,
  "osfo-kind": Schema.Literal("qualification-authority-stream-v1"),
  "osfo-plan-checksum": Schema.String,
  "osfo-previous-checksum": Schema.String,
  "osfo-record-count": Schema.String,
  "osfo-source-version": Schema.String,
});
const EncodedOwnerBundleDescriptor = Schema.fromJsonString(OwnerBundleDescriptor);
const EncodedOwnerResponse = Schema.fromJsonString(OwnerResponse);
const EncodedOwnerLegacyTerminalResponse = Schema.fromJsonString(OwnerLegacyTerminalResponse);
const EncodedOwnerDistributedEvaluationResponse = Schema.fromJsonString(
  OwnerDistributedEvaluationResponse,
);
const decodeOwnerWorkflowConflict = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.Literal("qualificationOwnerWorkflowConflict") }),
  ),
);
const decodeOwnerTerminalJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.optionalKey(Schema.Unknown) })),
);
const declaresOwnerTerminalVersion = (encoded: string): boolean => {
  const decoded = decodeOwnerTerminalJson(encoded);
  return Option.isSome(decoded) && "version" in decoded.value;
};
const EncodedOwnerReport = Schema.fromJsonString(OwnerReport);

type OwnerBundleDescriptor = typeof OwnerBundleDescriptor.Type;
type OwnerReport = typeof OwnerReport.Type;

export class ProductionQualificationOwnerUnavailable extends Data.TaggedError(
  "ProductionQualificationOwnerUnavailable",
)<{ readonly cause?: unknown; readonly message: string }> {}
export class ProductionQualificationOwnerConflict extends Data.TaggedError(
  "ProductionQualificationOwnerConflict",
)<{ readonly cause?: unknown; readonly message: string }> {}

const ownerUnavailable = (message: string, cause?: unknown) =>
  new ProductionQualificationOwnerUnavailable({ cause, message });
const ownerConflict = (message: string, cause?: unknown) =>
  new ProductionQualificationOwnerConflict({ cause, message });
const decode = <A, I>(schema: Schema.Codec<A, I>, value: I) =>
  Schema.decodeEffect(schema)(value).pipe(
    Effect.mapError((cause) => ownerConflict("Qualification owner artifact is invalid", cause)),
  );
const readRequired = (
  artifacts: ReturnType<typeof makeQualificationExecutionArtifactStore>,
  artifactId: string,
) =>
  artifacts
    .read(artifactId)
    .pipe(
      Effect.flatMap((encoded) =>
        encoded === null
          ? Effect.fail(ownerUnavailable(`Qualification owner artifact is missing: ${artifactId}`))
          : Effect.succeed(encoded),
      ),
    );

const exactAuthoritySources = (actual: ReadonlyArray<string>): boolean => {
  const expected = new Set<string>(qualificationAuthoritySources);
  return actual.length === expected.size && actual.every((source) => expected.delete(source));
};

const exactStreamComponents = (streams: OwnerBundleDescriptor["streams"]): boolean => {
  const expected = new Set<AuthorityStreamComponent>(authorityStreamComponents);
  return (
    streams.length === expected.size && streams.every(({ component }) => expected.delete(component))
  );
};

const verifyAuthorityStreamDescriptors = (
  bundle: OwnerBundleDescriptor,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
): boolean => {
  if (!exactAuthoritySources(bundle.authoritySources) || !exactStreamComponents(bundle.streams)) {
    return false;
  }
  const plannedFaultCount = plan.runs.filter((run) => run.fault !== null).length;
  return bundle.streams.every((stream) => {
    const expectedRecordCount =
      stream.component === "arrivals"
        ? plan.runs.reduce((total, run) => total + run.arrivalCount, 0)
        : stream.component === "faults"
          ? plannedFaultCount
          : stream.component === "runs"
            ? plan.runs.length
            : stream.component === "externalGates"
              ? manifest.requiredExternalGates.length
              : null;
    return (
      stream.artifactPrefix.startsWith(
        `qualification/executions/${encodeURIComponent(plan.executionId)}/authority-streams/`,
      ) &&
      stream.canonicalDigest.length > 8 &&
      stream.terminalChecksum.length > 8 &&
      stream.canonicalDigest === stream.terminalChecksum &&
      stream.sourceVersion === manifest.sourceVersion &&
      stream.verificationVersion === "qualification-owner-stream-v1" &&
      stream.chunkCount === Math.ceil(stream.recordCount / 256) &&
      (expectedRecordCount === null
        ? stream.recordCount > 0
        : stream.recordCount === expectedRecordCount)
    );
  });
};

const listedSha256 = (value: ArrayBuffer | ArrayBufferView): string =>
  value instanceof ArrayBuffer
    ? bytesToHex(new Uint8Array(value))
    : bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));

const verifyAuthorityStreamObjects = (
  bucket: QualificationExecutionListingBucket,
  bundle: OwnerBundleDescriptor,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
) =>
  Effect.gen(function* () {
    if (!verifyAuthorityStreamDescriptors(bundle, manifest, plan)) {
      return yield* ownerConflict("Qualification owner stream descriptors conflict with the plan");
    }
    for (const stream of bundle.streams) {
      let cursor: string | undefined;
      let expectedIndex = 0;
      let previousArtifactChecksum = "NONE";
      let recordCount = 0;
      do {
        const listOptions =
          cursor === undefined
            ? {
                include: ["customMetadata"] as const,
                limit: 100,
                prefix: `${stream.artifactPrefix}/`,
              }
            : {
                cursor,
                include: ["customMetadata"] as const,
                limit: 100,
                prefix: `${stream.artifactPrefix}/`,
              };
        const page = yield* Effect.tryPromise({
          catch: (cause) =>
            ownerUnavailable("Qualification authority stream listing failed", cause),
          try: () => bucket.list(listOptions),
        });
        if (page.truncated && page.objects.length === 0) {
          return yield* ownerConflict("Qualification authority listing did not advance");
        }
        for (const object of page.objects) {
          const metadata = yield* Schema.decodeUnknownEffect(AuthorityShardMetadata)(
            object.customMetadata,
          ).pipe(
            Effect.mapError((cause) =>
              ownerConflict("Qualification authority shard metadata is invalid", cause),
            ),
          );
          const chunkRecordCount = Number(metadata["osfo-record-count"]);
          const bodySha256 = object.checksums.sha256;
          const expectedKey = `${stream.artifactPrefix}/${expectedIndex.toString().padStart(8, "0")}.json`;
          const content = {
            bodySha256: metadata["osfo-body-sha256"],
            component: stream.component,
            executionId: plan.executionId,
            index: expectedIndex,
            planChecksum: plan.planChecksum,
            previousArtifactChecksum,
            recordCount: chunkRecordCount,
            sourceVersion: manifest.sourceVersion,
          };
          if (
            object.key !== expectedKey ||
            metadata["osfo-component"] !== stream.component ||
            metadata["osfo-execution-id"] !== plan.executionId ||
            metadata["osfo-index"] !== String(expectedIndex) ||
            metadata["osfo-plan-checksum"] !== plan.planChecksum ||
            metadata["osfo-previous-checksum"] !== previousArtifactChecksum ||
            metadata["osfo-source-version"] !== manifest.sourceVersion ||
            !Number.isInteger(chunkRecordCount) ||
            chunkRecordCount < 1 ||
            chunkRecordCount > 256 ||
            bodySha256 === undefined ||
            listedSha256(bodySha256) !== metadata["osfo-body-sha256"] ||
            metadata["osfo-artifact-checksum"] !== qualificationChecksum(content)
          ) {
            return yield* ownerConflict(
              `${stream.component} authority shard metadata conflicts at ${expectedIndex}`,
            );
          }
          previousArtifactChecksum = metadata["osfo-artifact-checksum"];
          recordCount += chunkRecordCount;
          expectedIndex += 1;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      if (
        expectedIndex !== stream.chunkCount ||
        recordCount !== stream.recordCount ||
        previousArtifactChecksum !== stream.terminalChecksum
      ) {
        return yield* ownerConflict(`${stream.component} retained authority stream is incomplete`);
      }
    }
    return undefined;
  });

const bigintText = /^-?[0-9]+$/;
const decodeBigInt = (value: string): bigint | null =>
  bigintText.test(value) ? BigInt(value) : null;
const reportFromWire = (wire: OwnerReport): ProductionQualificationReport | null => {
  const foreignExchangeUsdMicros = decodeBigInt(wire.foreignExchangeUsdMicros);
  const taxesUsdMicros = decodeBigInt(wire.taxesUsdMicros);
  const freeCostPerActivePeriodUsdMicros =
    wire.freeCostPerActivePeriodUsdMicros === null
      ? null
      : decodeBigInt(wire.freeCostPerActivePeriodUsdMicros);
  const costSummaries = wire.costSummaries.flatMap((summary) => {
    const totalUsdMicros = decodeBigInt(summary.totalUsdMicros);
    return totalUsdMicros === null ? [] : [{ ...summary, totalUsdMicros }];
  });
  if (
    foreignExchangeUsdMicros === null ||
    taxesUsdMicros === null ||
    (wire.freeCostPerActivePeriodUsdMicros !== null && freeCostPerActivePeriodUsdMicros === null) ||
    costSummaries.length !== wire.costSummaries.length
  ) {
    return null;
  }
  return {
    ...wire,
    costSummaries,
    foreignExchangeUsdMicros,
    freeCostPerActivePeriodUsdMicros,
    stageSummaries: wire.stageSummaries,
    taxesUsdMicros,
  };
};

/** Concrete production composition built from deployed Cloudflare bindings. */
export interface ProductionQualificationComposition {
  readonly artifacts: ReturnType<typeof makeQualificationExecutionArtifactStore>;
  readonly owner: QualificationOwnerBinding | null;
}

/** Private service-binding surface owned by the out-of-process qualification executor. */
export interface QualificationOwnerBinding {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/** Minimal deployed bindings consumed by the production qualification facade. */
export interface ProductionQualificationBindings {
  readonly ARTIFACTS: QualificationExecutionListingBucket;
  readonly QUALIFICATION_OWNER?: QualificationOwnerBinding;
}

export const makeProductionQualificationComposition = (
  env: ProductionQualificationBindings,
): ProductionQualificationComposition => ({
  artifacts: makeQualificationExecutionArtifactStore(env.ARTIFACTS),
  owner: env.QUALIFICATION_OWNER ?? null,
});

const ownerRequest = (
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  cohort: QualificationCohortManifest,
) => {
  const content = {
    authoritySources: qualificationAuthoritySources,
    cohortArtifactChecksum: cohort.artifactChecksum,
    cohortArtifactId: qualificationCohortArtifactId(plan.executionId),
    executionId: plan.executionId,
    manifest,
    manifestChecksum: manifest.manifestChecksum,
    plan,
    planChecksum: plan.planChecksum,
    protocolVersion: "qualification-owner-v1",
    shardRecordLimit: 256,
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

const retainOwnerRequest = (
  artifacts: QualificationExecutionArtifactStore<QualificationExecutionArtifactUnavailable>,
  artifactId: string,
  encoded: string,
): Effect.Effect<
  void,
  QualificationExecutionArtifactUnavailable | ProductionQualificationOwnerConflict
> =>
  Effect.gen(function* () {
    const retained = yield* artifacts.read(artifactId);
    if (retained === encoded) return undefined;
    if (retained !== null) {
      return yield* ownerConflict("Qualification execution identity has another frozen plan");
    }
    yield* artifacts.writeImmutable(artifactId, encoded);
    return undefined;
  });

/**
 * Submit a compact frozen plan to the private bounded owner and verify every retained authority
 * stream one shard at a time before accepting its immutable report artifact.
 */
export const runProductionQualification = (
  env: ProductionQualificationBindings,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
): Promise<ProductionQualificationReport> => {
  const composition = makeProductionQualificationComposition(env);
  if (composition.owner === null) {
    return Promise.resolve(
      unavailableProductionQualificationReport(
        manifest,
        "productionQualificationOwnerMissing",
        `${plan.executionId} requires the private bounded QUALIFICATION_OWNER service binding`,
        "MISSING",
      ),
    );
  }
  const owner = composition.owner;
  const execute = Effect.gen(function* () {
    const cohortArtifactId = qualificationCohortArtifactId(plan.executionId);
    const encodedCohort = yield* readRequired(composition.artifacts, cohortArtifactId);
    const cohort = decodeQualificationCohortManifest(encodedCohort);
    if (
      cohort === null ||
      cohort.executionId !== plan.executionId ||
      cohort.manifestChecksum !== manifest.manifestChecksum ||
      cohort.planChecksum !== plan.planChecksum ||
      cohort.sourceVersion !== manifest.sourceVersion
    ) {
      return yield* ownerConflict("Disposable qualification cohort conflicts with the plan");
    }
    const requestArtifact = ownerRequest(manifest, plan, cohort);
    const expectedRootCount = plan.runs.reduce((total, run) => total + run.arrivalCount, 0);
    const partitionCount = plan.runs.reduce(
      (total, run) => total + Math.ceil(run.arrivalCount / 256),
      0,
    );
    const expectedDimensionCount =
      qualificationOwnerDimensionCoordinatorBudget(plan).dimensionCount;
    const requestArtifactId = `qualification/executions/${encodeURIComponent(plan.executionId)}/owner-request.json`;
    yield* retainOwnerRequest(
      composition.artifacts,
      requestArtifactId,
      canonicalQualificationJson(requestArtifact),
    );
    const response = yield* Effect.tryPromise({
      catch: (cause) => ownerUnavailable("Qualification owner request failed", cause),
      try: () =>
        owner.fetch("https://qualification-owner.internal/v1/executions", {
          body: canonicalQualificationJson({
            executionId: plan.executionId,
            manifestChecksum: manifest.manifestChecksum,
            planChecksum: plan.planChecksum,
            requestArtifactId,
            requestArtifactChecksum: requestArtifact.artifactChecksum,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
    });
    if (response.status === 202) {
      return yield* ownerUnavailable("Qualification owner execution remains in progress");
    }
    if (response.status === 424 || response.status === 409) {
      const encodedTerminal = yield* Effect.tryPromise({
        catch: (cause) => ownerUnavailable("Qualification owner terminal body failed", cause),
        try: () => response.text(),
      });
      if (response.status === 409 && Option.isSome(decodeOwnerWorkflowConflict(encodedTerminal))) {
        return yield* ownerConflict("Qualification owner retained an immutable conflict");
      }
      const terminal = declaresOwnerTerminalVersion(encodedTerminal)
        ? yield* decode(EncodedOwnerDistributedEvaluationResponse, encodedTerminal)
        : yield* decode(EncodedOwnerLegacyTerminalResponse, encodedTerminal);
      if ("failureCodes" in terminal) {
        return yield* ownerUnavailable(`Qualification owner returned ${response.status}`);
      }
      if (
        terminal.executionId !== plan.executionId ||
        terminal.manifestChecksum !== manifest.manifestChecksum ||
        terminal.planChecksum !== plan.planChecksum
      ) {
        return yield* ownerConflict("Qualification owner terminal report conflicts with the plan");
      }
      if (!("version" in terminal)) {
        if (response.status !== 424 || terminal.missingSources.length === 0) {
          return yield* ownerConflict("Qualification owner MISSING report conflicts with the plan");
        }
        return unavailableProductionQualificationReport(
          manifest,
          "productionQualificationAuthorityMissing",
          `Missing product authority sources: ${terminal.missingSources.join(", ")}`,
          "MISSING",
        );
      }
      const material = yield* Effect.tryPromise({
        catch: (cause) =>
          ownerUnavailable("Distributed qualification report readback failed", cause),
        try: () =>
          authenticateQualificationDistributedEvaluationReport({
            acceptanceLevel: manifest.acceptanceLevel,
            artifactId: terminal.reportArtifactId,
            bucket: env.ARTIFACTS,
            checksum: terminal.reportChecksum,
            executionId: plan.executionId,
            expectedDimensionCount,
            expectedRootCount,
            manifestChecksum: manifest.manifestChecksum,
            planChecksum: plan.planChecksum,
            sourceVersion: manifest.sourceVersion,
            topologyVersion: manifest.topologyVersion,
          }),
      });
      if (material.status !== "COMPLETE") {
        return yield* material.status === "FAIL"
          ? ownerConflict("Distributed qualification report conflicts with its response")
          : ownerUnavailable("Distributed qualification report is missing");
      }
      const completion = yield* Effect.tryPromise({
        catch: (cause) =>
          ownerUnavailable("Distributed qualification report completion readback failed", cause),
        try: () =>
          authenticateQualificationDistributedEvaluationReportCompletion({
            artifactId: terminal.completionArtifactId,
            bucket: env.ARTIFACTS,
            checksum: terminal.completionChecksum,
            executionId: plan.executionId,
            failingFamilyCount: material.report.failingFamilyCount,
            manifestChecksum: manifest.manifestChecksum,
            missingFamilyCount: material.report.missingFamilyCount,
            planChecksum: plan.planChecksum,
            reportArtifactId: terminal.reportArtifactId,
            reportChecksum: terminal.reportChecksum,
            verdict: material.report.verdict,
          }),
      });
      if (completion.status !== "COMPLETE") {
        return yield* completion.status === "FAIL"
          ? ownerConflict("Distributed qualification report completion conflicts with its response")
          : ownerUnavailable("Distributed qualification report completion is missing");
      }
      if (
        completion.completion.verdict !== terminal.verdict ||
        completion.completion.verdict !== material.report.verdict ||
        completion.completion.failingFamilyCount !== material.report.failingFamilyCount ||
        completion.completion.missingFamilyCount !== material.report.missingFamilyCount
      ) {
        return yield* ownerConflict(
          "Distributed qualification report completion conflicts with its report",
        );
      }
      const correctnessFamily = material.report.families.find(
        ({ family }) => family === "forest_correctness",
      );
      if (correctnessFamily === undefined) {
        return yield* ownerConflict("Distributed correctness family is missing");
      }
      const correctnessReference = correctnessFamily.references[0];
      if (correctnessReference !== undefined) {
        if (correctnessReference.kind !== "correctness") {
          return yield* ownerConflict("Distributed correctness reference kind conflicts");
        }
        const reference = yield* Effect.tryPromise({
          catch: (cause) =>
            ownerUnavailable("Distributed correctness reference readback failed", cause),
          try: () =>
            authenticateQualificationDistributedCorrectnessReference({
              artifactId: correctnessReference.artifactId,
              bucket: env.ARTIFACTS,
              checksum: correctnessReference.checksum,
              executionId: plan.executionId,
              expectedAcceptedCount: correctnessReference.acceptedCount,
              expectedRootCount: correctnessReference.rootCount,
              partitionCount,
              planChecksum: plan.planChecksum,
              verdict: correctnessFamily.verdict,
            }),
        });
        if (reference.status !== "COMPLETE") {
          return yield* reference.status === "FAIL"
            ? ownerConflict("Distributed correctness reference conflicts with its report")
            : ownerUnavailable("Distributed correctness reference is missing");
        }
      }
      const dimensionFamily = material.report.families.find(
        ({ family }) => family === "numeric_stage_operation_dimensions",
      );
      if (dimensionFamily === undefined) {
        return yield* ownerConflict("Distributed dimension family is missing");
      }
      const dimensionReference = dimensionFamily.references[0];
      if (dimensionReference !== undefined) {
        if (dimensionReference.kind !== "dimensions") {
          return yield* ownerConflict("Distributed dimension reference kind conflicts");
        }
        const reference = yield* Effect.tryPromise({
          catch: (cause) =>
            ownerUnavailable("Distributed dimension reference readback failed", cause),
          try: () =>
            authenticateQualificationDistributedDimensionReference({
              artifactId: dimensionReference.artifactId,
              bucket: env.ARTIFACTS,
              checksum: dimensionReference.checksum,
              executionId: plan.executionId,
              expectedDimensionCount: dimensionReference.dimensionCount,
              planChecksum: plan.planChecksum,
              verdict: dimensionFamily.verdict,
            }),
        });
        if (reference.status !== "COMPLETE") {
          return yield* reference.status === "FAIL"
            ? ownerConflict("Distributed dimension reference conflicts with its report")
            : ownerUnavailable("Distributed dimension reference is missing");
        }
      }
      const failingFamilies = material.report.families
        .filter(({ verdict }) => verdict === "FAIL")
        .map(({ family }) => family);
      const missingFamilies = material.report.families
        .filter(({ verdict }) => verdict === "MISSING")
        .map(({ family }) => family);
      if (
        material.report.sourceVersion !== manifest.sourceVersion ||
        material.report.topologyVersion !== manifest.topologyVersion ||
        material.report.acceptanceLevel !== manifest.acceptanceLevel ||
        material.report.verdict !== terminal.verdict ||
        terminal.error !==
          (terminal.verdict === "FAIL"
            ? "qualificationAuthorityConflict"
            : "qualificationAuthorityMaterialMissing") ||
        canonicalQualificationJson(failingFamilies) !==
          canonicalQualificationJson(terminal.failingFamilies) ||
        canonicalQualificationJson(missingFamilies) !==
          canonicalQualificationJson(terminal.missingFamilies) ||
        response.status !== (terminal.verdict === "FAIL" ? 409 : 424)
      ) {
        return yield* ownerConflict("Distributed qualification report identity conflicts");
      }
      return unavailableProductionQualificationReport(
        manifest,
        terminal.verdict === "FAIL"
          ? "productionQualificationDistributedReportFailed"
          : "productionQualificationDistributedReportMissing",
        terminal.verdict === "FAIL"
          ? `Failed qualification families: ${failingFamilies.join(", ")}`
          : `Missing qualification families: ${missingFamilies.join(", ")}`,
        terminal.verdict,
      );
    }
    if (!response.ok)
      return yield* ownerUnavailable(`Qualification owner returned ${response.status}`);
    const ownerResponse = yield* Effect.tryPromise({
      catch: (cause) => ownerUnavailable("Qualification owner response body failed", cause),
      try: () => response.text(),
    }).pipe(Effect.flatMap((encoded) => decode(EncodedOwnerResponse, encoded)));
    if (
      ownerResponse.executionId !== plan.executionId ||
      ownerResponse.manifestChecksum !== manifest.manifestChecksum ||
      ownerResponse.planChecksum !== plan.planChecksum
    ) {
      return yield* ownerConflict("Qualification owner response is bound to another execution");
    }
    const bundle = yield* readRequired(composition.artifacts, ownerResponse.bundleArtifactId).pipe(
      Effect.flatMap((encoded) => decode(EncodedOwnerBundleDescriptor, encoded)),
    );
    const { artifactChecksum, ...bundleContent } = bundle;
    if (
      artifactChecksum !== qualificationChecksum(bundleContent) ||
      artifactChecksum !== ownerResponse.bundleArtifactChecksum ||
      bundle.executionId !== plan.executionId ||
      bundle.manifestChecksum !== manifest.manifestChecksum ||
      bundle.planChecksum !== plan.planChecksum
    ) {
      return yield* ownerConflict("Qualification owner bundle conflicts with the frozen plan");
    }
    yield* verifyAuthorityStreamObjects(env.ARTIFACTS, bundle, manifest, plan);
    const encodedReport = yield* readRequired(composition.artifacts, bundle.reportArtifactId);
    if (qualificationChecksum({ encodedReport }) !== bundle.reportArtifactChecksum) {
      return yield* ownerConflict("Qualification owner report checksum conflicts");
    }
    const wire = yield* decode(EncodedOwnerReport, encodedReport);
    const expectedEvaluationInputChecksum = qualificationChecksum({
      authoritySources: bundle.authoritySources,
      executionId: bundle.executionId,
      manifestChecksum: bundle.manifestChecksum,
      planChecksum: bundle.planChecksum,
      productAuthorityStreams: bundle.productAuthorityStreams,
      streams: bundle.streams,
    });
    if (
      wire.evaluationInputChecksum !== expectedEvaluationInputChecksum ||
      wire.executionId !== plan.executionId ||
      wire.manifestChecksum !== manifest.manifestChecksum ||
      wire.planChecksum !== plan.planChecksum
    ) {
      return yield* ownerConflict("Qualification owner report is unrelated to verified streams");
    }
    const report = reportFromWire(wire);
    if (report === null)
      return yield* ownerConflict("Qualification owner report fields are invalid");
    return report;
  });
  return Effect.runPromise(
    execute.pipe(
      Effect.catch(
        (
          error:
            | QualificationExecutionArtifactUnavailable
            | ProductionQualificationOwnerConflict
            | ProductionQualificationOwnerUnavailable,
        ) =>
          Effect.succeed(
            unavailableProductionQualificationReport(
              manifest,
              error instanceof ProductionQualificationOwnerConflict
                ? "productionQualificationOwnerConflict"
                : "productionQualificationOwnerUnavailable",
              error.message,
              error instanceof ProductionQualificationOwnerConflict ? "FAIL" : "MISSING",
            ),
          ),
      ),
    ),
  );
};
