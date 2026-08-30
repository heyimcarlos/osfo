/* oxlint-disable effecttsgo/async-function, effecttsgo/catch-to-or-else-succeed, effecttsgo/prefer-typed-schema-decoder, effecttsgo/schema-sync-in-effect, effecttsgo/try-catch-in-effect-gen, effecttsgo/unnecessary-fail-yieldable-error, eslint/no-underscore-dangle -- This module owns Promise-native R2, schema, and Effect tagged-result boundaries. */
import { Data, Effect, Schema } from "effect";

import {
  decodeFrozenQualificationExecution,
  type FrozenQualificationInvocation,
} from "../qualification/frozen-execution";
import type { QualificationDistributedEvaluationReport } from "../qualification/distributed-evaluation-report";
import { qualificationOwnerDimensionCoordinatorBudget } from "../qualification/owner-partitions";
import {
  QualificationPostTeardownCompletion,
  QualificationPostTeardownConflict,
  QualificationPostTeardownReceipt,
  QualificationPostTeardownReport,
  QualificationPostTeardownResponse,
  qualificationPostTeardownCompletion,
  qualificationPostTeardownCompletionArtifactId,
  qualificationPostTeardownConflict,
  qualificationPostTeardownConflictArtifactId,
  qualificationPostTeardownReceipt,
  qualificationPostTeardownReceiptArtifactId,
  qualificationPostTeardownReport,
  qualificationPostTeardownReportArtifactId,
  qualificationPostTeardownResponse,
  qualificationPostTeardownResponseArtifactId,
} from "../qualification/post-teardown-evaluation";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type {
  QualificationPostTeardownAuthorityInspection,
  QualificationPostTeardownPublicationClaim,
  QualificationPostTeardownPublicationIdentity,
  QualificationPostTeardownPublicationMutation,
  QualificationPostTeardownPublicationUnavailable,
} from "../integrations/postgres/qualification-post-teardown";
import { authenticateQualificationExecutionRunCorpusReceipt } from "./qualification-execution-run-corpus";
import {
  authenticateQualificationDistributedCorrectnessReference,
  authenticateQualificationDistributedDimensionReference,
  authenticateQualificationDistributedEvaluationConflict,
  authenticateQualificationDistributedEvaluationReport,
  authenticateQualificationDistributedEvaluationReportCompletion,
  qualificationDistributedEvaluationConflictArtifactId,
} from "./qualification-owner-report";

interface RetainedObject {
  readonly customMetadata?: Readonly<Record<string, string>>;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly text: () => Promise<string>;
}
interface RetainedPutResult {
  readonly etag?: string;
}
export interface QualificationPostTeardownBucket {
  readonly get: (key: string) => Promise<RetainedObject | null>;
  readonly put: (
    key: string,
    value: string,
    options: {
      readonly customMetadata: Readonly<Record<string, string>>;
      readonly httpMetadata: { readonly contentType: string };
      readonly onlyIf: { readonly etagDoesNotMatch: string };
    },
  ) => Promise<RetainedPutResult | null>;
}
export interface QualificationPostTeardownPublicationPort {
  readonly inspectAuthority: (input: {
    readonly cohortArtifactChecksum: string;
    readonly cohortArtifactId: string;
    readonly cohortId: string;
    readonly executionId: string;
    readonly manifestChecksum: string;
    readonly planChecksum: string;
    readonly sourceVersion: string;
  }) => Effect.Effect<
    QualificationPostTeardownAuthorityInspection,
    QualificationPostTeardownPublicationUnavailable
  >;
  readonly pinInput: MutationPort;
  readonly publish: (
    identity: QualificationPostTeardownPublicationIdentity,
    token: string,
    inputChecksum: string,
    artifactChecksum: string,
  ) => Effect.Effect<
    QualificationPostTeardownPublicationMutation,
    QualificationPostTeardownPublicationUnavailable
  >;
  readonly release: (
    identity: QualificationPostTeardownPublicationIdentity,
    token: string,
    backoffMilliseconds: number,
  ) => Effect.Effect<
    QualificationPostTeardownPublicationMutation,
    QualificationPostTeardownPublicationUnavailable
  >;
  readonly retainConflict: (
    identity: QualificationPostTeardownPublicationIdentity,
    token: string,
    inputChecksum: string,
    checksum: string,
  ) => Effect.Effect<
    QualificationPostTeardownPublicationMutation,
    QualificationPostTeardownPublicationUnavailable
  >;
  readonly retainIneligible: (
    identity: QualificationPostTeardownPublicationIdentity,
    token: string,
    inputChecksum: string,
    checksum: string,
  ) => Effect.Effect<
    QualificationPostTeardownPublicationMutation,
    QualificationPostTeardownPublicationUnavailable
  >;
}
type MutationPort = (
  identity: QualificationPostTeardownPublicationIdentity,
  token: string,
  checksum: string,
) => Effect.Effect<
  QualificationPostTeardownPublicationMutation,
  QualificationPostTeardownPublicationUnavailable
>;

export class QualificationPostTeardownFinalizationConflict extends Data.TaggedError(
  "QualificationPostTeardownFinalizationConflict",
)<{ readonly artifactId: string; readonly message: string }> {}
export class QualificationPostTeardownFinalizationUnavailable extends Data.TaggedError(
  "QualificationPostTeardownFinalizationUnavailable",
)<{ readonly cause: unknown; readonly operation: string }> {}

const OwnerResponse = Schema.Struct({
  body: Schema.Struct({
    completionArtifactId: Schema.String,
    completionChecksum: Schema.String,
    error: Schema.String,
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
  }),
  status: Schema.Literals([409, 424]),
});
type PostStage = "receipt" | "report" | "completion" | "response" | "conflict";
type PostValue =
  | QualificationPostTeardownReceipt
  | QualificationPostTeardownReport
  | typeof QualificationPostTeardownCompletion.Type
  | typeof QualificationPostTeardownResponse.Type
  | QualificationPostTeardownConflict;
interface PostArtifact {
  readonly artifactId: string;
  readonly checksum: string;
  readonly kind: string;
  readonly stage: PostStage;
  readonly value: PostValue;
}
export type QualificationPostTeardownFinalizationOutcome = {
  readonly _tag: "Published" | "Ineligible" | "Released";
  readonly checksum: string;
};

/** Validate a terminal PostgreSQL replay only after the caller reconstructed the exact POST chain. */
export const qualificationPostTeardownTerminalReplay = (
  claim: Extract<QualificationPostTeardownPublicationClaim, { readonly _tag: "Terminal" }>,
  expectedInputChecksum: string,
  expectedArtifactChecksum: string,
): QualificationPostTeardownFinalizationOutcome => {
  if (
    claim.inputChecksum !== expectedInputChecksum ||
    claim.artifactChecksum !== expectedArtifactChecksum ||
    (claim.state !== "PUBLISHED" && claim.state !== "INELIGIBLE")
  )
    throw new QualificationPostTeardownFinalizationConflict({
      artifactId: "qualification-post-teardown-publication",
      message: "Terminal publication replay conflicts",
    });
  return {
    _tag: claim.state === "PUBLISHED" ? "Published" : "Ineligible",
    checksum: expectedArtifactChecksum,
  };
};
type FinalizationInput = {
  readonly bucket: QualificationPostTeardownBucket;
  readonly claim: Extract<QualificationPostTeardownPublicationClaim, { readonly _tag: "Claimed" }>;
  readonly invocation: FrozenQualificationInvocation;
  readonly publication: QualificationPostTeardownPublicationPort;
  readonly releaseBackoffMilliseconds: number;
};

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const exactMetadata = (
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
) =>
  actual !== undefined &&
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => actual[key] === value);
const metadataFor = async (artifact: PostArtifact, executionId: string, inputChecksum: string) => ({
  "osfo-artifact-checksum": artifact.checksum,
  "osfo-body-sha256": await sha256Hex(canonicalQualificationJson(artifact.value)),
  "osfo-execution-id": executionId,
  "osfo-finalization-input-checksum": inputChecksum,
  "osfo-kind": artifact.kind,
});
const decodePost = (stage: PostStage, encoded: string): PostValue => {
  if (stage === "receipt")
    return Schema.decodeUnknownSync(Schema.fromJsonString(QualificationPostTeardownReceipt))(
      encoded,
    );
  if (stage === "report")
    return Schema.decodeUnknownSync(Schema.fromJsonString(QualificationPostTeardownReport))(
      encoded,
    );
  if (stage === "completion")
    return Schema.decodeUnknownSync(Schema.fromJsonString(QualificationPostTeardownCompletion))(
      encoded,
    );
  if (stage === "conflict")
    return Schema.decodeUnknownSync(Schema.fromJsonString(QualificationPostTeardownConflict))(
      encoded,
    );
  return Schema.decodeUnknownSync(Schema.fromJsonString(QualificationPostTeardownResponse))(
    encoded,
  );
};
const retainedArtifactMatches = async (
  retained: RetainedObject,
  retainedBody: string,
  artifact: PostArtifact,
  executionId: string,
  inputChecksum: string,
) => {
  const encoded = canonicalQualificationJson(artifact.value);
  try {
    return (
      retainedBody === encoded &&
      canonicalQualificationJson(decodePost(artifact.stage, retainedBody)) === encoded &&
      retained.httpMetadata?.contentType === "application/json" &&
      exactMetadata(
        retained.customMetadata,
        await metadataFor(artifact, executionId, inputChecksum),
      )
    );
  } catch {
    return false;
  }
};
const authenticateArtifact = async (
  bucket: QualificationPostTeardownBucket,
  artifact: PostArtifact,
  executionId: string,
  inputChecksum: string,
): Promise<"ABSENT" | "CONFLICT" | "EXACT"> => {
  const retained = await bucket.get(artifact.artifactId);
  if (retained === null) return "ABSENT";
  const body = await retained.text();
  return (await retainedArtifactMatches(retained, body, artifact, executionId, inputChecksum))
    ? "EXACT"
    : "CONFLICT";
};
const createAbsentArtifact = async (
  bucket: QualificationPostTeardownBucket,
  artifact: PostArtifact,
  executionId: string,
  inputChecksum: string,
): Promise<"CONFLICT" | "EXACT"> => {
  const encoded = canonicalQualificationJson(artifact.value);
  const metadata = await metadataFor(artifact, executionId, inputChecksum);
  const put = await bucket.put(artifact.artifactId, encoded, {
    customMetadata: metadata,
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (put !== null) return "EXACT";
  return (await authenticateArtifact(bucket, artifact, executionId, inputChecksum)) === "EXACT"
    ? "EXACT"
    : "CONFLICT";
};
const mutationApplied = (
  mutation: QualificationPostTeardownPublicationMutation,
  artifactId: string,
) =>
  mutation._tag === "Applied"
    ? Effect.void
    : Effect.fail(
        new QualificationPostTeardownFinalizationConflict({
          artifactId,
          message: `Publication mutation did not apply: ${mutation._tag}`,
        }),
      );
const corpusFamily = (report: QualificationDistributedEvaluationReport) =>
  report.families.find((candidate) => candidate.family === "execution_run_corpus");
const corpusIsLegacy = (report: QualificationDistributedEvaluationReport) => {
  const family = corpusFamily(report);
  return (
    family?.verdict === "MISSING" &&
    family.reason === "authority_not_installed_pre_teardown" &&
    family.failCount === 0 &&
    family.missingCount === 1 &&
    family.references.length === 0
  );
};
const makeFinalizationRuntime = (input: FinalizationInput) => {
  const identity = {
    cohortId: input.claim.cohortId,
    dispatchId: input.claim.dispatchId,
    executionId: input.claim.executionId,
  };
  const get = Effect.fn("QualificationPostTeardown.get")((key: string) =>
    Effect.tryPromise({
      try: () => input.bucket.get(key),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: `get:${key}`,
        }),
    }),
  );
  const release = Effect.fn("QualificationPostTeardown.release")(function* (reason: string) {
    yield* mutationApplied(
      yield* input.publication.release(
        identity,
        input.claim.claimToken,
        input.releaseBackoffMilliseconds,
      ),
      input.invocation.requestArtifactId,
    );
    return { _tag: "Released", checksum: qualificationChecksum({ reason }) } as const;
  });
  const settleInputConflict = Effect.fn("QualificationPostTeardown.settleInputConflict")(function* (
    artifactId: string,
    reason: string,
  ) {
    const observedChecksum = qualificationChecksum({
      artifactId,
      executionId: identity.executionId,
      reason,
    });
    const pinnedChecksum = input.claim.inputChecksum ?? observedChecksum;
    if (input.claim.inputChecksum === null) {
      const pinned = yield* input.publication.pinInput(
        identity,
        input.claim.claimToken,
        pinnedChecksum,
      );
      if (pinned._tag !== "Applied")
        return yield* Effect.fail(
          new QualificationPostTeardownFinalizationConflict({ artifactId, message: reason }),
        );
    }
    const retained = yield* input.publication.retainConflict(
      identity,
      input.claim.claimToken,
      pinnedChecksum,
      observedChecksum,
    );
    if (retained._tag !== "Applied")
      return yield* Effect.fail(
        new QualificationPostTeardownFinalizationConflict({ artifactId, message: reason }),
      );
    return yield* Effect.fail(
      new QualificationPostTeardownFinalizationConflict({ artifactId, message: reason }),
    );
  });
  const pinExact = Effect.fn("QualificationPostTeardown.pinExact")(function* (
    checksum: string,
    artifactId: string,
  ) {
    const pinned = yield* input.publication.pinInput(identity, input.claim.claimToken, checksum);
    if (pinned._tag !== "Applied")
      return yield* settleInputConflict(artifactId, "Finalization input checksum conflicts");
    return undefined;
  });
  return { get, identity, input, pinExact, release, settleInputConflict } as const;
};
type FinalizationRuntime = ReturnType<typeof makeFinalizationRuntime>;
type AuthenticatedPreTeardown = {
  readonly completionArtifactId: string;
  readonly completionChecksum: string;
  readonly expectedRootCount: number;
  readonly frozen: NonNullable<ReturnType<typeof decodeFrozenQualificationExecution>>;
  readonly partitionCount: number;
  readonly report: QualificationDistributedEvaluationReport;
  readonly responseId: string;
  readonly responseSha: string;
};
type PreTeardownResult =
  | { readonly _tag: "Authenticated"; readonly authority: AuthenticatedPreTeardown }
  | { readonly _tag: "Done"; readonly outcome: QualificationPostTeardownFinalizationOutcome };
const preTeardownDone = (
  outcome: QualificationPostTeardownFinalizationOutcome,
): PreTeardownResult => ({ _tag: "Done", outcome });
const authenticatePreTeardown = Effect.fn("QualificationPostTeardown.authenticatePreTeardown")(
  function* (runtime: FinalizationRuntime) {
    const { identity, input } = runtime;
    const requestObject = yield* runtime.get(input.invocation.requestArtifactId);
    if (requestObject === null)
      return preTeardownDone(yield* runtime.release("ownerRequestMissing"));
    const requestEncoded = yield* Effect.tryPromise({
      try: () => requestObject.text(),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: "ownerRequest.text",
        }),
    });
    const frozen = decodeFrozenQualificationExecution(requestEncoded, input.invocation);
    if (
      frozen === null ||
      requestObject.httpMetadata?.contentType !== "application/json" ||
      !exactMetadata(requestObject.customMetadata, { "osfo-kind": "qualification-execution-v1" })
    )
      return yield* runtime.settleInputConflict(
        input.invocation.requestArtifactId,
        "Frozen owner request conflicts",
      );
    const expectedRootCount = frozen.plan.runs.reduce((total, run) => total + run.arrivalCount, 0);
    const partitionCount = frozen.plan.runs.reduce(
      (total, run) => total + Math.ceil(run.arrivalCount / 256),
      0,
    );
    const expectedDimensionCount = qualificationOwnerDimensionCoordinatorBudget(
      frozen.plan,
    ).dimensionCount;
    const preConflict = yield* Effect.tryPromise({
      try: () =>
        authenticateQualificationDistributedEvaluationConflict({
          bucket: input.bucket,
          executionId: identity.executionId,
          manifestChecksum: input.invocation.manifestChecksum,
          planChecksum: input.invocation.planChecksum,
        }),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: "authenticatePreConflict",
        }),
    });
    if (preConflict === "CONFLICT")
      return yield* runtime.settleInputConflict(
        qualificationDistributedEvaluationConflictArtifactId(identity.executionId),
        "PRE distributed evaluation conflict marker is retained",
      );
    const responseId = `qualification/executions/${encodeURIComponent(identity.executionId)}/owner-response.json`;
    const responseObject = yield* runtime.get(responseId);
    if (responseObject === null)
      return preTeardownDone(yield* runtime.release("preResponseMissing"));
    const responseEncoded = yield* Effect.tryPromise({
      try: () => responseObject.text(),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: "preResponse.text",
        }),
    });
    let response: typeof OwnerResponse.Type;
    try {
      response = Schema.decodeSync(Schema.fromJsonString(OwnerResponse))(responseEncoded);
    } catch {
      return yield* runtime.settleInputConflict(responseId, "PRE response conflicts");
    }
    if (canonicalQualificationJson(response) !== responseEncoded)
      return yield* runtime.settleInputConflict(responseId, "PRE response is not canonical");
    const reportMaterial = yield* Effect.tryPromise({
      try: () =>
        authenticateQualificationDistributedEvaluationReport({
          acceptanceLevel: frozen.manifest.acceptanceLevel,
          artifactId: response.body.reportArtifactId,
          bucket: input.bucket,
          checksum: response.body.reportChecksum,
          executionId: identity.executionId,
          expectedDimensionCount,
          expectedRootCount,
          manifestChecksum: input.invocation.manifestChecksum,
          planChecksum: input.invocation.planChecksum,
          sourceVersion: frozen.manifest.sourceVersion,
          topologyVersion: frozen.manifest.topologyVersion,
        }),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: "authenticatePreReport",
        }),
    });
    if (reportMaterial.status === "MISSING")
      return preTeardownDone(yield* runtime.release("preReportMissing"));
    if (reportMaterial.status !== "COMPLETE")
      return yield* runtime.settleInputConflict(
        response.body.reportArtifactId,
        "PRE report conflicts",
      );
    const report = reportMaterial.report;
    const completionMaterial = yield* Effect.tryPromise({
      try: () =>
        authenticateQualificationDistributedEvaluationReportCompletion({
          artifactId: response.body.completionArtifactId,
          bucket: input.bucket,
          checksum: response.body.completionChecksum,
          executionId: identity.executionId,
          failingFamilyCount: report.failingFamilyCount,
          manifestChecksum: report.manifestChecksum,
          missingFamilyCount: report.missingFamilyCount,
          planChecksum: report.planChecksum,
          reportArtifactId: report.artifactId,
          reportChecksum: report.checksum,
          verdict: report.verdict,
        }),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: "authenticatePreCompletion",
        }),
    });
    if (completionMaterial.status === "MISSING")
      return preTeardownDone(yield* runtime.release("preCompletionMissing"));
    if (completionMaterial.status !== "COMPLETE")
      return yield* runtime.settleInputConflict(
        response.body.completionArtifactId,
        "PRE completion conflicts",
      );
    const responseSha = yield* Effect.promise(() => sha256Hex(responseEncoded));
    if (
      response.body.executionId !== identity.executionId ||
      response.body.manifestChecksum !== input.invocation.manifestChecksum ||
      response.body.planChecksum !== input.invocation.planChecksum ||
      response.body.reportArtifactId !== report.artifactId ||
      response.body.reportChecksum !== report.checksum ||
      response.body.completionArtifactId !== completionMaterial.completion.artifactId ||
      response.body.completionChecksum !== completionMaterial.completion.checksum ||
      responseObject.httpMetadata?.contentType !== "application/json" ||
      !exactMetadata(responseObject.customMetadata, {
        "osfo-body-sha256": responseSha,
        "osfo-execution-id": identity.executionId,
        "osfo-kind": "qualification-owner-response-v2",
        "osfo-manifest-checksum": input.invocation.manifestChecksum,
        "osfo-plan-checksum": input.invocation.planChecksum,
        "osfo-report-checksum": report.checksum,
        "osfo-verdict": report.verdict,
      })
    )
      return yield* runtime.settleInputConflict(responseId, "PRE lineage conflicts");
    const failingFamilies = report.families
      .filter(({ verdict }) => verdict === "FAIL")
      .map(({ family }) => family);
    const missingFamilies = report.families
      .filter(({ verdict }) => verdict === "MISSING")
      .map(({ family }) => family);
    if (
      response.body.verdict !== report.verdict ||
      completionMaterial.completion.verdict !== report.verdict ||
      response.status !== (report.verdict === "FAIL" ? 409 : 424) ||
      response.body.error !==
        (report.verdict === "FAIL"
          ? "qualificationAuthorityConflict"
          : "qualificationAuthorityMaterialMissing") ||
      canonicalQualificationJson(response.body.failingFamilies) !==
        canonicalQualificationJson(failingFamilies) ||
      canonicalQualificationJson(response.body.missingFamilies) !==
        canonicalQualificationJson(missingFamilies)
    )
      return yield* runtime.settleInputConflict(responseId, "PRE response summary conflicts");
    const correctnessFamily = report.families.find(({ family }) => family === "forest_correctness");
    const correctnessReference = correctnessFamily?.references[0];
    if (correctnessFamily !== undefined && correctnessReference?.kind === "correctness") {
      const material = yield* Effect.tryPromise({
        try: () =>
          authenticateQualificationDistributedCorrectnessReference({
            artifactId: correctnessReference.artifactId,
            bucket: input.bucket,
            checksum: correctnessReference.checksum,
            executionId: identity.executionId,
            expectedAcceptedCount: correctnessReference.acceptedCount,
            expectedRootCount: correctnessReference.rootCount,
            partitionCount,
            planChecksum: input.invocation.planChecksum,
            verdict: correctnessFamily.verdict,
          }),
        catch: (cause) =>
          new QualificationPostTeardownFinalizationUnavailable({
            cause,
            operation: "authenticateCorrectnessReference",
          }),
      });
      if (material.status === "MISSING")
        return preTeardownDone(yield* runtime.release("correctnessReferenceMissing"));
      if (material.status !== "COMPLETE")
        return yield* runtime.settleInputConflict(
          correctnessReference.artifactId,
          "PRE correctness reference conflicts",
        );
    } else if (correctnessFamily?.references.length !== 0) {
      return yield* runtime.settleInputConflict(
        report.artifactId,
        "PRE correctness reference kind conflicts",
      );
    }
    const dimensionFamily = report.families.find(
      ({ family }) => family === "numeric_stage_operation_dimensions",
    );
    const dimensionReference = dimensionFamily?.references[0];
    if (dimensionFamily !== undefined && dimensionReference?.kind === "dimensions") {
      const material = yield* Effect.tryPromise({
        try: () =>
          authenticateQualificationDistributedDimensionReference({
            artifactId: dimensionReference.artifactId,
            bucket: input.bucket,
            checksum: dimensionReference.checksum,
            executionId: identity.executionId,
            expectedDimensionCount: dimensionReference.dimensionCount,
            planChecksum: input.invocation.planChecksum,
            verdict: dimensionFamily.verdict,
          }),
        catch: (cause) =>
          new QualificationPostTeardownFinalizationUnavailable({
            cause,
            operation: "authenticateDimensionReference",
          }),
      });
      if (material.status === "MISSING")
        return preTeardownDone(yield* runtime.release("dimensionReferenceMissing"));
      if (material.status !== "COMPLETE")
        return yield* runtime.settleInputConflict(
          dimensionReference.artifactId,
          "PRE dimension reference conflicts",
        );
    } else if (dimensionFamily?.references.length !== 0) {
      return yield* runtime.settleInputConflict(
        report.artifactId,
        "PRE dimension reference kind conflicts",
      );
    }
    if (corpusIsLegacy(report)) {
      const checksum = qualificationChecksum({
        executionId: identity.executionId,
        ownerRequestChecksum: input.invocation.requestArtifactChecksum,
        preCompletionChecksum: completionMaterial.completion.checksum,
        preReportChecksum: report.checksum,
        preResponseChecksum: responseSha,
        reason: "legacyPreTeardown",
      });
      yield* runtime.pinExact(checksum, report.artifactId);
      yield* mutationApplied(
        yield* input.publication.retainIneligible(
          identity,
          input.claim.claimToken,
          checksum,
          checksum,
        ),
        report.artifactId,
      );
      return preTeardownDone({ _tag: "Ineligible", checksum });
    }
    const corpus = corpusFamily(report);
    const corpusReference = corpus?.references[0];
    if (
      corpus?.verdict !== "PASS" ||
      corpus.references.length !== 1 ||
      corpusReference?.kind !== "executionCorpus"
    )
      return yield* runtime.settleInputConflict(
        report.artifactId,
        "PRE execution corpus family conflicts",
      );
    const corpusMaterial = yield* Effect.tryPromise({
      try: () =>
        authenticateQualificationExecutionRunCorpusReceipt({
          artifactId: corpusReference.artifactId,
          bucket: input.bucket,
          checksum: corpusReference.checksum,
          executionId: identity.executionId,
          expectedRootCount,
          manifestChecksum: input.invocation.manifestChecksum,
          partitionCount,
          planChecksum: input.invocation.planChecksum,
          sourceVersion: frozen.manifest.sourceVersion,
          topologyVersion: frozen.manifest.topologyVersion,
        }),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: "authenticateExecutionCorpus",
        }),
    });
    if (corpusMaterial.status === "MISSING")
      return preTeardownDone(yield* runtime.release("executionCorpusMissing"));
    if (
      corpusMaterial.status !== "COMPLETE" ||
      corpusMaterial.receipt.acceptedCount !== corpusReference.acceptedCount ||
      corpusMaterial.receipt.completionCount !== corpusReference.completionCount ||
      corpusMaterial.receipt.pageCount !== corpusReference.pageCount ||
      corpusMaterial.receipt.partitionCount !== corpusReference.partitionCount ||
      corpusMaterial.receipt.rootCount !== corpusReference.rootCount ||
      corpusMaterial.receipt.terminalJoinPageChecksum !==
        corpusReference.terminalJoinPageChecksum ||
      corpusMaterial.receipt.terminalLaunchPageChecksum !==
        corpusReference.terminalLaunchPageChecksum
    )
      return yield* runtime.settleInputConflict(
        corpusReference.artifactId,
        "PRE execution corpus conflicts",
      );
    return {
      _tag: "Authenticated",
      authority: {
        completionArtifactId: completionMaterial.completion.artifactId,
        completionChecksum: completionMaterial.completion.checksum,
        expectedRootCount,
        frozen,
        partitionCount,
        report,
        responseId,
        responseSha,
      },
    } satisfies PreTeardownResult;
  },
);
const makeStageConflict = (input: {
  readonly artifact: PostArtifact;
  readonly completion: typeof QualificationPostTeardownCompletion.Type;
  readonly inputChecksum: string;
  readonly ownerRequestChecksum: string;
  readonly preCompletionChecksum: string;
  readonly preReportChecksum: string;
  readonly preResponseChecksum: string;
  readonly receipt: QualificationPostTeardownReceipt;
  readonly report: QualificationPostTeardownReport;
}) => {
  const common = {
    conflictingArtifactId: input.artifact.artifactId,
    executionId: input.receipt.executionId,
    finalizationInputChecksum: input.inputChecksum,
    manifestChecksum: input.receipt.manifestChecksum,
    ownerRequestChecksum: input.ownerRequestChecksum,
    planChecksum: input.receipt.planChecksum,
    preTeardownCompletionChecksum: input.preCompletionChecksum,
    preTeardownReportChecksum: input.preReportChecksum,
    preTeardownResponseChecksum: input.preResponseChecksum,
  };
  if (input.artifact.stage === "receipt")
    return qualificationPostTeardownConflict({ ...common, stage: "receipt" });
  if (input.artifact.stage === "report")
    return qualificationPostTeardownConflict({
      ...common,
      stage: "report",
      teardownReceiptChecksum: input.receipt.checksum,
    });
  if (input.artifact.stage === "completion")
    return qualificationPostTeardownConflict({
      ...common,
      reportChecksum: input.report.checksum,
      stage: "completion",
      teardownReceiptChecksum: input.receipt.checksum,
    });
  return qualificationPostTeardownConflict({
    ...common,
    completionChecksum: input.completion.checksum,
    reportChecksum: input.report.checksum,
    stage: "response",
    teardownReceiptChecksum: input.receipt.checksum,
  });
};
type PostChain = {
  readonly artifacts: ReadonlyArray<PostArtifact>;
  readonly chainChecksum: string;
  readonly completion: typeof QualificationPostTeardownCompletion.Type;
  readonly finalizationInputChecksum: string;
  readonly preCompletionChecksum: string;
  readonly preReportChecksum: string;
  readonly preResponseChecksum: string;
  readonly receipt: QualificationPostTeardownReceipt;
  readonly report: QualificationPostTeardownReport;
};
const retainPostChain = Effect.fn("QualificationPostTeardown.retainPostChain")(function* (
  runtime: FinalizationRuntime,
  chain: PostChain,
) {
  const { identity, input } = runtime;
  const conflictArtifactId = qualificationPostTeardownConflictArtifactId(identity.executionId);
  const settleCollision = Effect.fn("QualificationPostTeardown.settlePostCollision")(function* (
    artifact: PostArtifact,
  ) {
    const marker = makeStageConflict({
      artifact,
      completion: chain.completion,
      inputChecksum: chain.finalizationInputChecksum,
      ownerRequestChecksum: input.invocation.requestArtifactChecksum,
      preCompletionChecksum: chain.preCompletionChecksum,
      preReportChecksum: chain.preReportChecksum,
      preResponseChecksum: chain.preResponseChecksum,
      receipt: chain.receipt,
      report: chain.report,
    });
    const markerArtifact: PostArtifact = {
      artifactId: conflictArtifactId,
      checksum: marker.checksum,
      kind: "qualification-post-teardown-evaluation-conflict-v1",
      stage: "conflict",
      value: marker,
    };
    const markerResult = yield* Effect.tryPromise({
      try: () =>
        createAbsentArtifact(
          input.bucket,
          markerArtifact,
          identity.executionId,
          chain.finalizationInputChecksum,
        ),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: "retain:conflict",
        }),
    });
    if (markerResult !== "EXACT") {
      const conflictChecksum = qualificationChecksum({
        artifactId: marker.artifactId,
        executionId: identity.executionId,
        reason: "POST conflict marker conflicts",
      });
      yield* mutationApplied(
        yield* input.publication.retainConflict(
          identity,
          input.claim.claimToken,
          chain.finalizationInputChecksum,
          conflictChecksum,
        ),
        marker.artifactId,
      );
      return yield* Effect.fail(
        new QualificationPostTeardownFinalizationConflict({
          artifactId: marker.artifactId,
          message: "POST conflict marker conflicts",
        }),
      );
    }
    yield* mutationApplied(
      yield* input.publication.retainConflict(
        identity,
        input.claim.claimToken,
        chain.finalizationInputChecksum,
        marker.checksum,
      ),
      marker.artifactId,
    );
    return yield* Effect.fail(
      new QualificationPostTeardownFinalizationConflict({
        artifactId: artifact.artifactId,
        message: "Immutable POST artifact conflicts",
      }),
    );
  });

  const retainedMarker = yield* runtime.get(conflictArtifactId);
  if (retainedMarker !== null) {
    const markerEncoded = yield* Effect.tryPromise({
      try: () => retainedMarker.text(),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: "conflict.text",
        }),
    });
    let retainedConflict: QualificationPostTeardownConflict;
    try {
      retainedConflict = Schema.decodeUnknownSync(
        Schema.fromJsonString(QualificationPostTeardownConflict),
      )(markerEncoded);
    } catch {
      const conflictChecksum = qualificationChecksum({
        artifactId: conflictArtifactId,
        executionId: identity.executionId,
        reason: "POST conflict marker is malformed",
      });
      yield* mutationApplied(
        yield* input.publication.retainConflict(
          identity,
          input.claim.claimToken,
          chain.finalizationInputChecksum,
          conflictChecksum,
        ),
        conflictArtifactId,
      );
      return yield* Effect.fail(
        new QualificationPostTeardownFinalizationConflict({
          artifactId: conflictArtifactId,
          message: "POST conflict marker is malformed",
        }),
      );
    }
    const target = chain.artifacts.find(({ stage }) => stage === retainedConflict.stage);
    if (target === undefined) {
      const conflictChecksum = qualificationChecksum({
        artifactId: retainedConflict.artifactId,
        executionId: identity.executionId,
        reason: "POST conflict marker target is unavailable",
      });
      yield* mutationApplied(
        yield* input.publication.retainConflict(
          identity,
          input.claim.claimToken,
          chain.finalizationInputChecksum,
          conflictChecksum,
        ),
        retainedConflict.artifactId,
      );
      return yield* Effect.fail(
        new QualificationPostTeardownFinalizationConflict({
          artifactId: retainedConflict.artifactId,
          message: "POST conflict marker target is unavailable",
        }),
      );
    }
    const expected = makeStageConflict({
      artifact: target,
      completion: chain.completion,
      inputChecksum: chain.finalizationInputChecksum,
      ownerRequestChecksum: input.invocation.requestArtifactChecksum,
      preCompletionChecksum: chain.preCompletionChecksum,
      preReportChecksum: chain.preReportChecksum,
      preResponseChecksum: chain.preResponseChecksum,
      receipt: chain.receipt,
      report: chain.report,
    });
    const expectedArtifact: PostArtifact = {
      artifactId: expected.artifactId,
      checksum: expected.checksum,
      kind: "qualification-post-teardown-evaluation-conflict-v1",
      stage: "conflict",
      value: expected,
    };
    const markerIsExact = yield* Effect.tryPromise({
      try: () =>
        retainedArtifactMatches(
          retainedMarker,
          markerEncoded,
          expectedArtifact,
          identity.executionId,
          chain.finalizationInputChecksum,
        ),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: "authenticate:conflict",
        }),
    });
    if (!markerIsExact) {
      const conflictChecksum = qualificationChecksum({
        artifactId: retainedConflict.artifactId,
        executionId: identity.executionId,
        reason: "POST conflict marker conflicts",
      });
      yield* mutationApplied(
        yield* input.publication.retainConflict(
          identity,
          input.claim.claimToken,
          chain.finalizationInputChecksum,
          conflictChecksum,
        ),
        retainedConflict.artifactId,
      );
      return yield* Effect.fail(
        new QualificationPostTeardownFinalizationConflict({
          artifactId: retainedConflict.artifactId,
          message: "POST conflict marker conflicts",
        }),
      );
    }
    yield* mutationApplied(
      yield* input.publication.retainConflict(
        identity,
        input.claim.claimToken,
        chain.finalizationInputChecksum,
        expected.checksum,
      ),
      expected.artifactId,
    );
    return yield* Effect.fail(
      new QualificationPostTeardownFinalizationConflict({
        artifactId: target.artifactId,
        message: "Retained POST conflict marker dominates replay",
      }),
    );
  }

  const initialStates = new Array<"ABSENT" | "CONFLICT" | "EXACT">();
  for (const artifact of chain.artifacts)
    initialStates.push(
      yield* Effect.tryPromise({
        try: () =>
          authenticateArtifact(
            input.bucket,
            artifact,
            identity.executionId,
            chain.finalizationInputChecksum,
          ),
        catch: (cause) =>
          new QualificationPostTeardownFinalizationUnavailable({
            cause,
            operation: `authenticate:${artifact.stage}`,
          }),
      }),
    );
  const firstAbsent = initialStates.indexOf("ABSENT");
  const firstConflict = initialStates.indexOf("CONFLICT");
  const conflictingArtifact = chain.artifacts[firstConflict];
  if (conflictingArtifact !== undefined) return yield* settleCollision(conflictingArtifact);
  if (firstAbsent >= 0 && initialStates.slice(firstAbsent + 1).some((state) => state === "EXACT")) {
    const missingPredecessor = chain.artifacts[firstAbsent];
    if (missingPredecessor !== undefined) return yield* settleCollision(missingPredecessor);
  }
  for (const [artifactIndex, artifact] of chain.artifacts.entries()) {
    if (initialStates[artifactIndex] === "EXACT") continue;
    const result = yield* Effect.tryPromise({
      try: () =>
        createAbsentArtifact(
          input.bucket,
          artifact,
          identity.executionId,
          chain.finalizationInputChecksum,
        ),
      catch: (cause) =>
        new QualificationPostTeardownFinalizationUnavailable({
          cause,
          operation: `retain:${artifact.stage}`,
        }),
    });
    if (result === "EXACT") continue;
    return yield* settleCollision(artifact);
  }
  yield* mutationApplied(
    yield* input.publication.publish(
      identity,
      input.claim.claimToken,
      chain.finalizationInputChecksum,
      chain.chainChecksum,
    ),
    qualificationPostTeardownResponseArtifactId(identity.executionId),
  );
  return { _tag: "Published", checksum: chain.chainChecksum } as const;
});

export const finalizeQualificationPostTeardown = Effect.fn("QualificationPostTeardown.finalize")(
  (input: FinalizationInput) =>
    Effect.gen(function* () {
      const runtime = makeFinalizationRuntime(input);
      const preTeardown = yield* authenticatePreTeardown(runtime);
      if (preTeardown._tag === "Done") return preTeardown.outcome;
      const pre = preTeardown.authority;
      const inspected = yield* input.publication
        .inspectAuthority({
          cohortArtifactChecksum: pre.frozen.cohortArtifactChecksum,
          cohortArtifactId: pre.frozen.cohortArtifactId,
          cohortId: runtime.identity.cohortId,
          executionId: runtime.identity.executionId,
          manifestChecksum: input.invocation.manifestChecksum,
          planChecksum: input.invocation.planChecksum,
          sourceVersion: pre.frozen.manifest.sourceVersion,
        })
        .pipe(
          Effect.map((inspection) => ({ available: true as const, inspection })),
          Effect.catch(() => Effect.succeed({ available: false as const })),
        );
      if (!inspected.available) return yield* runtime.release("teardownInspectionUnavailable");
      const inspection = inspected.inspection;
      if (inspection._tag === "Missing" || inspection._tag === "Pending")
        return yield* runtime.release(`teardown${inspection._tag}`);
      const normalizedInspection =
        inspection._tag === "Conflict"
          ? {
              _tag: "Failed" as const,
              cohortId: runtime.identity.cohortId,
              dispatchId: runtime.identity.dispatchId,
              executionId: runtime.identity.executionId,
              failureChecksum: qualificationChecksum({
                cohortArtifactChecksum: pre.frozen.cohortArtifactChecksum,
                cohortId: runtime.identity.cohortId,
                executionId: runtime.identity.executionId,
                reason: "settledAuthorityConflict",
              }),
              manifestChecksum: input.invocation.manifestChecksum,
              planChecksum: input.invocation.planChecksum,
              sourceVersion: pre.frozen.manifest.sourceVersion,
            }
          : inspection;
      const finalizationInputChecksum = qualificationChecksum({
        cohortArtifactChecksum: pre.frozen.cohortArtifactChecksum,
        cohortArtifactId: pre.frozen.cohortArtifactId,
        cohortId: runtime.identity.cohortId,
        executionId: runtime.identity.executionId,
        inspection: normalizedInspection,
        ownerRequestChecksum: input.invocation.requestArtifactChecksum,
        preCompletionChecksum: pre.completionChecksum,
        preReportChecksum: pre.report.checksum,
        preResponseChecksum: pre.responseSha,
      });
      yield* runtime.pinExact(finalizationInputChecksum, input.invocation.requestArtifactId);
      const lineage = {
        executionId: runtime.identity.executionId,
        manifestChecksum: input.invocation.manifestChecksum,
        ownerRequestChecksum: input.invocation.requestArtifactChecksum,
        planChecksum: input.invocation.planChecksum,
        preTeardownCompletionChecksum: pre.completionChecksum,
        preTeardownReportChecksum: pre.report.checksum,
        preTeardownResponseChecksum: pre.responseSha,
        sourceVersion: pre.frozen.manifest.sourceVersion,
      };
      const receipt = qualificationPostTeardownReceipt(
        normalizedInspection._tag === "Ready"
          ? {
              ...lineage,
              allocationIdentityCount: normalizedInspection.allocationIdentityCount,
              artifactAuthorityProofChecksum: normalizedInspection.artifactAuthorityProofChecksum,
              artifactAuthorityProtocol: normalizedInspection.artifactAuthorityProtocol,
              cohortArtifactChecksum: normalizedInspection.cohortArtifactChecksum,
              cohortArtifactId: normalizedInspection.cohortArtifactId,
              cohortId: normalizedInspection.cohortId,
              dispatchId: normalizedInspection.dispatchId,
              dispatchProtocolVersion: normalizedInspection.dispatchProtocolVersion,
              expectedPageCount: normalizedInspection.expectedPageCount,
              expectedParticipantCount: normalizedInspection.expectedParticipantCount,
              finalPageChecksum: normalizedInspection.finalPageChecksum,
              provisionIdentityCount: normalizedInspection.provisionIdentityCount,
              qualificationRootAttemptCount: normalizedInspection.qualificationRootAttemptCount,
              rootChecksum: normalizedInspection.rootChecksum,
              rootInstanceId: normalizedInspection.rootInstanceId,
              teardownVerdict: "PASS",
            }
          : {
              ...lineage,
              cohortId: normalizedInspection.cohortId,
              dispatchId: normalizedInspection.dispatchId,
              failureChecksum: normalizedInspection.failureChecksum,
              failureKind:
                inspection._tag === "Conflict" ? "settledAuthorityConflict" : "dispatchConflict",
              teardownVerdict: "FAIL",
            },
      );
      const postReport = qualificationPostTeardownReport({
        ownerRequestChecksum: input.invocation.requestArtifactChecksum,
        preTeardownCompletionArtifactId: pre.completionArtifactId,
        preTeardownCompletionChecksum: pre.completionChecksum,
        preTeardownReport: pre.report,
        preTeardownResponseArtifactId: pre.responseId,
        preTeardownResponseChecksum: pre.responseSha,
        teardownReceipt: receipt,
      });
      const completion = qualificationPostTeardownCompletion(postReport);
      const postResponse = qualificationPostTeardownResponse(postReport, completion);
      const artifacts: ReadonlyArray<PostArtifact> = [
        {
          artifactId: qualificationPostTeardownReceiptArtifactId(runtime.identity.executionId),
          checksum: receipt.checksum,
          kind: "qualification-post-teardown-evaluation-receipt-v1",
          stage: "receipt",
          value: receipt,
        },
        {
          artifactId: qualificationPostTeardownReportArtifactId(runtime.identity.executionId),
          checksum: postReport.checksum,
          kind: "qualification-post-teardown-evaluation-report-v1",
          stage: "report",
          value: postReport,
        },
        {
          artifactId: qualificationPostTeardownCompletionArtifactId(runtime.identity.executionId),
          checksum: completion.checksum,
          kind: "qualification-post-teardown-evaluation-completion-v1",
          stage: "completion",
          value: completion,
        },
        {
          artifactId: qualificationPostTeardownResponseArtifactId(runtime.identity.executionId),
          checksum: qualificationChecksum(postResponse),
          kind: "qualification-post-teardown-owner-response-v1",
          stage: "response",
          value: postResponse,
        },
      ];
      const chainChecksum = qualificationChecksum({
        completionChecksum: completion.checksum,
        reportChecksum: postReport.checksum,
        responseChecksum: qualificationChecksum(postResponse),
        teardownReceiptChecksum: receipt.checksum,
      });
      return yield* retainPostChain(runtime, {
        artifacts,
        chainChecksum,
        completion,
        finalizationInputChecksum,
        preCompletionChecksum: pre.completionChecksum,
        preReportChecksum: pre.report.checksum,
        preResponseChecksum: pre.responseSha,
        receipt,
        report: postReport,
      });
    }).pipe(
      Effect.catch((failure) =>
        failure instanceof QualificationPostTeardownFinalizationUnavailable
          ? Effect.gen(function* () {
              const identity = {
                cohortId: input.claim.cohortId,
                dispatchId: input.claim.dispatchId,
                executionId: input.claim.executionId,
              };
              const released = yield* input.publication.release(
                identity,
                input.claim.claimToken,
                input.releaseBackoffMilliseconds,
              );
              yield* mutationApplied(released, input.invocation.requestArtifactId);
              return {
                _tag: "Released",
                checksum: qualificationChecksum({
                  operation: failure.operation,
                  reason: "transientUnavailable",
                }),
              } as const;
            })
          : Effect.fail(failure),
      ),
    ),
);
