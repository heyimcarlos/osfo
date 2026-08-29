import { Option, Predicate, Schema } from "effect";

import { qualificationAuthoritySources } from "./authority-sources";
import { createQualificationExecutionPlan, type QualificationExecutionPlan } from "./execution";
import { qualificationChecksum } from "./qualification-checksum";
import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
  type ProductionQualificationManifest,
} from "./qualification-manifest";

const RetainedOwnerRequest = Schema.Struct({
  artifactChecksum: Schema.String,
  authoritySources: Schema.Array(Schema.String),
  cohortArtifactChecksum: Schema.String,
  cohortArtifactId: Schema.String,
  executionId: Schema.String,
  manifest: Schema.Unknown,
  manifestChecksum: Schema.String,
  plan: Schema.Unknown,
  planChecksum: Schema.String,
  protocolVersion: Schema.Literal("qualification-owner-v1"),
  shardRecordLimit: Schema.Literal(256),
});
const FrozenManifestIdentity = Schema.Struct({
  acceptanceLevel: Schema.Literals(["BoundedBeta", "ScaleQualifiedPublic"]),
  dependencyVersions: Schema.Record(Schema.String, Schema.String),
  hardLimits: Schema.Array(
    Schema.Struct({ maximum: Schema.Finite, name: Schema.String, unit: Schema.String }),
  ),
  manifestChecksum: Schema.String,
  sourceVersion: Schema.String,
  topologyVersion: Schema.String,
  workloadSeed: Schema.Int,
});
const FrozenPlanIdentity = Schema.Struct({
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
  startsAtEpochMs: Schema.Int,
});

const decodeOwnerRequest = Schema.decodeUnknownOption(Schema.fromJsonString(RetainedOwnerRequest));
const decodeManifestIdentity = Schema.decodeUnknownOption(FrozenManifestIdentity);
const decodePlanIdentity = Schema.decodeUnknownOption(FrozenPlanIdentity);

export interface FrozenQualificationInvocation {
  readonly executionId: string;
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly requestArtifactChecksum: string;
  readonly requestArtifactId: string;
}

export interface FrozenQualificationExecution {
  readonly cohortArtifactChecksum: string;
  readonly cohortArtifactId: string;
  readonly manifest: ProductionQualificationManifest;
  readonly plan: QualificationExecutionPlan;
}

const exactSources = (sources: ReadonlyArray<string>): boolean => {
  const expected = new Set<string>(qualificationAuthoritySources);
  return sources.length === expected.size && sources.every((source) => expected.delete(source));
};

/** Reconstruct server-owned policy and reject any self-consistent but noncanonical request body. */
export const decodeFrozenQualificationExecution = (
  encoded: string,
  invocation: FrozenQualificationInvocation,
): FrozenQualificationExecution | null => {
  const expectedArtifactId = `qualification/executions/${encodeURIComponent(invocation.executionId)}/owner-request.json`;
  if (invocation.requestArtifactId !== expectedArtifactId) return null;
  const decodedRequest = decodeOwnerRequest(encoded);
  if (Option.isNone(decodedRequest)) return null;
  const { artifactChecksum, ...content } = decodedRequest.value;
  if (
    artifactChecksum !== invocation.requestArtifactChecksum ||
    artifactChecksum !== qualificationChecksum(content) ||
    decodedRequest.value.executionId !== invocation.executionId ||
    decodedRequest.value.manifestChecksum !== invocation.manifestChecksum ||
    decodedRequest.value.planChecksum !== invocation.planChecksum ||
    !exactSources(decodedRequest.value.authoritySources)
  )
    return null;
  const manifestIdentity = decodeManifestIdentity(decodedRequest.value.manifest);
  const planIdentity = decodePlanIdentity(decodedRequest.value.plan);
  if (
    Option.isNone(manifestIdentity) ||
    Option.isNone(planIdentity) ||
    !Predicate.isObject(decodedRequest.value.manifest) ||
    !Predicate.isObject(decodedRequest.value.plan)
  )
    return null;
  const versions = {
    dependencyVersions: manifestIdentity.value.dependencyVersions,
    hardLimits: manifestIdentity.value.hardLimits,
    sourceVersion: manifestIdentity.value.sourceVersion,
    topologyVersion: manifestIdentity.value.topologyVersion,
    workloadSeed: manifestIdentity.value.workloadSeed,
  };
  const manifest =
    manifestIdentity.value.acceptanceLevel === "BoundedBeta"
      ? createBoundedBetaManifest(versions)
      : createScaleQualifiedPublicManifest(versions);
  const plan = createQualificationExecutionPlan(
    manifest,
    planIdentity.value.startsAtEpochMs,
    invocation.executionId,
  );
  return manifest.manifestChecksum === manifestIdentity.value.manifestChecksum &&
    manifest.manifestChecksum === invocation.manifestChecksum &&
    qualificationChecksum(manifest) === qualificationChecksum(decodedRequest.value.manifest) &&
    plan.planChecksum === planIdentity.value.planChecksum &&
    plan.planChecksum === invocation.planChecksum &&
    qualificationChecksum(plan) === qualificationChecksum(decodedRequest.value.plan)
    ? {
        cohortArtifactChecksum: decodedRequest.value.cohortArtifactChecksum,
        cohortArtifactId: decodedRequest.value.cohortArtifactId,
        manifest,
        plan,
      }
    : null;
};
