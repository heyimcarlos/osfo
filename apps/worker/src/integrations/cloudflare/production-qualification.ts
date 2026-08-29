import { Data, Effect, Schema } from "effect";

import type { CostSummaryEvidence } from "../../qualification/cost-evidence";
import type { QualificationExecutionPlan } from "../../qualification/execution";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../../qualification/qualification-checksum";
import type { ProductionQualificationManifest } from "../../qualification/qualification-manifest";
import {
  unavailableProductionQualificationReport,
  type ProductionQualificationReport,
} from "../../qualification/production-qualification";
import {
  makeQualificationExecutionArtifactStore,
  type QualificationExecutionBucket,
  type QualificationExecutionArtifactUnavailable,
} from "./qualification-execution-artifacts";

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

const requiredAuthoritySources = [
  "allowance_and_billing_ledger",
  "gmail_provider_receipts",
  "memory_commit_receipts",
  "model_access_receipts",
  "osfo_agent_activation_log",
  "osfo_committed_turns",
  "provider_delivery_receipts",
  "qualification_fault_controller_receipts",
  "r2_object_metadata",
  "task_compute_receipts",
  "think_submission_receipts",
  "whatsapp_delivery_receipts",
  "worker_admission_receipts",
  "workflow_instance_receipts",
] as const;
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
const OwnerBundleDescriptor = Schema.Struct({
  artifactChecksum: Schema.String,
  authoritySources: Schema.Array(Schema.String),
  evaluatorVersion: Schema.Literal("production-qualification-v1"),
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  ownerIdentity: Schema.Literal("osfo-qualification-owner-v1"),
  planChecksum: Schema.String,
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
const EncodedOwnerBundleDescriptor = Schema.fromJsonString(OwnerBundleDescriptor);
const EncodedOwnerResponse = Schema.fromJsonString(OwnerResponse);
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
  const expected = new Set<string>(requiredAuthoritySources);
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
  readonly ARTIFACTS: QualificationExecutionBucket;
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
) => {
  const content = {
    authoritySources: requiredAuthoritySources,
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
    const requestArtifact = ownerRequest(manifest, plan);
    const requestArtifactId = `qualification/executions/${encodeURIComponent(plan.executionId)}/owner-request.json`;
    yield* composition.artifacts.writeImmutable(
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
    if (!verifyAuthorityStreamDescriptors(bundle, manifest, plan)) {
      return yield* ownerConflict("Qualification owner stream descriptors conflict with the plan");
    }
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
