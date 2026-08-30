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
  authenticateQualificationDistributedEvaluationReport,
  authenticateQualificationDistributedEvaluationReportCompletion,
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
const authenticateArtifact = async (
  bucket: QualificationPostTeardownBucket,
  artifact: PostArtifact,
  executionId: string,
  inputChecksum: string,
): Promise<"ABSENT" | "CONFLICT" | "EXACT"> => {
  const encoded = canonicalQualificationJson(artifact.value);
  const metadata = await metadataFor(artifact, executionId, inputChecksum);
  const retained = await bucket.get(artifact.artifactId);
  if (retained === null) return "ABSENT";
  const body = await retained.text();
  try {
    return body === encoded &&
      canonicalQualificationJson(decodePost(artifact.stage, body)) === encoded &&
      retained.httpMetadata?.contentType === "application/json" &&
      exactMetadata(retained.customMetadata, metadata)
      ? "EXACT"
      : "CONFLICT";
  } catch {
    return "CONFLICT";
  }
};
const retainArtifact = async (
  bucket: QualificationPostTeardownBucket,
  artifact: PostArtifact,
  executionId: string,
  inputChecksum: string,
): Promise<"CONFLICT" | "EXACT"> => {
  const encoded = canonicalQualificationJson(artifact.value);
  const metadata = await metadataFor(artifact, executionId, inputChecksum);
  const authenticate = async (retained: RetainedObject | null) => {
    if (retained === null) return false;
    const body = await retained.text();
    try {
      return (
        body === encoded &&
        canonicalQualificationJson(decodePost(artifact.stage, body)) === encoded &&
        retained.httpMetadata?.contentType === "application/json" &&
        exactMetadata(retained.customMetadata, metadata)
      );
    } catch {
      return false;
    }
  };
  const existing = await bucket.get(artifact.artifactId);
  if (existing !== null) return (await authenticate(existing)) ? "EXACT" : "CONFLICT";
  const put = await bucket.put(artifact.artifactId, encoded, {
    customMetadata: metadata,
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (put !== null) return "EXACT";
  return (await authenticate(await bucket.get(artifact.artifactId))) ? "EXACT" : "CONFLICT";
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

export const finalizeQualificationPostTeardown = Effect.fn("QualificationPostTeardown.finalize")(
  (input: FinalizationInput) =>
    Effect.gen(function* () {
      const identity = {
        cohortId: input.claim.cohortId,
        dispatchId: input.claim.dispatchId,
        executionId: input.claim.executionId,
      };
      const get = (key: string) =>
        Effect.tryPromise({
          try: () => input.bucket.get(key),
          catch: (cause) =>
            new QualificationPostTeardownFinalizationUnavailable({
              cause,
              operation: `get:${key}`,
            }),
        });
      const release = (reason: string) =>
        Effect.gen(function* () {
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
      const settleInputConflict = (artifactId: string, reason: string) =>
        Effect.gen(function* () {
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
      const pinExact = (checksum: string, artifactId: string) =>
        Effect.gen(function* () {
          const pinned = yield* input.publication.pinInput(
            identity,
            input.claim.claimToken,
            checksum,
          );
          if (pinned._tag === "Applied") return true;
          return yield* settleInputConflict(artifactId, "Finalization input checksum conflicts");
        });
      const requestObject = yield* get(input.invocation.requestArtifactId);
      if (requestObject === null) return yield* release("ownerRequestMissing");
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
        return yield* settleInputConflict(
          input.invocation.requestArtifactId,
          "Frozen owner request conflicts",
        );
      const expectedRootCount = frozen.plan.runs.reduce(
        (total, run) => total + run.arrivalCount,
        0,
      );
      const expectedDimensionCount = qualificationOwnerDimensionCoordinatorBudget(
        frozen.plan,
      ).dimensionCount;
      const responseId = `qualification/executions/${encodeURIComponent(input.invocation.executionId)}/owner-response.json`;
      const responseObject = yield* get(responseId);
      if (responseObject === null) return yield* release("preResponseMissing");
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
        return yield* settleInputConflict(responseId, "PRE response conflicts");
      }
      if (canonicalQualificationJson(response) !== responseEncoded)
        return yield* settleInputConflict(responseId, "PRE response is not canonical");
      const reportMaterial = yield* Effect.tryPromise({
        try: () =>
          authenticateQualificationDistributedEvaluationReport({
            acceptanceLevel: frozen.manifest.acceptanceLevel,
            artifactId: response.body.reportArtifactId,
            bucket: input.bucket,
            checksum: response.body.reportChecksum,
            executionId: input.invocation.executionId,
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
      if (reportMaterial.status === "MISSING") return yield* release("preReportMissing");
      if (reportMaterial.status !== "COMPLETE")
        return yield* settleInputConflict(response.body.reportArtifactId, "PRE report conflicts");
      const report = reportMaterial.report;
      const completionMaterial = yield* Effect.tryPromise({
        try: () =>
          authenticateQualificationDistributedEvaluationReportCompletion({
            artifactId: response.body.completionArtifactId,
            bucket: input.bucket,
            checksum: response.body.completionChecksum,
            executionId: input.invocation.executionId,
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
      if (completionMaterial.status === "MISSING") return yield* release("preCompletionMissing");
      if (completionMaterial.status !== "COMPLETE")
        return yield* settleInputConflict(
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
        return yield* settleInputConflict(responseId, "PRE lineage conflicts");
      if (corpusIsLegacy(report)) {
        const checksum = qualificationChecksum({
          executionId: identity.executionId,
          ownerRequestChecksum: input.invocation.requestArtifactChecksum,
          preCompletionChecksum: completionMaterial.completion.checksum,
          preReportChecksum: report.checksum,
          preResponseChecksum: responseSha,
          reason: "legacyPreTeardown",
        });
        yield* pinExact(checksum, report.artifactId);
        yield* mutationApplied(
          yield* input.publication.retainIneligible(
            identity,
            input.claim.claimToken,
            checksum,
            checksum,
          ),
          report.artifactId,
        );
        return { _tag: "Ineligible", checksum } as const;
      }
      const corpus = corpusFamily(report);
      const corpusReference = corpus?.references[0];
      if (
        corpus?.verdict !== "PASS" ||
        corpus.references.length !== 1 ||
        corpusReference?.kind !== "executionCorpus"
      )
        return yield* settleInputConflict(
          report.artifactId,
          "PRE execution corpus family conflicts",
        );
      const partitionCount = frozen.plan.runs.reduce(
        (total, run) => total + Math.ceil(run.arrivalCount / 256),
        0,
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
      if (corpusMaterial.status === "MISSING") return yield* release("executionCorpusMissing");
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
        return yield* settleInputConflict(
          corpusReference.artifactId,
          "PRE execution corpus conflicts",
        );
      const inspected = yield* input.publication
        .inspectAuthority({
          cohortArtifactChecksum: frozen.cohortArtifactChecksum,
          cohortArtifactId: frozen.cohortArtifactId,
          cohortId: identity.cohortId,
          executionId: identity.executionId,
          manifestChecksum: input.invocation.manifestChecksum,
          planChecksum: input.invocation.planChecksum,
          sourceVersion: frozen.manifest.sourceVersion,
        })
        .pipe(
          Effect.map((inspection) => ({ available: true as const, inspection })),
          Effect.catch(() => Effect.succeed({ available: false as const })),
        );
      if (!inspected.available) return yield* release("teardownInspectionUnavailable");
      const inspection = inspected.inspection;
      if (inspection._tag === "Missing" || inspection._tag === "Pending")
        return yield* release(`teardown${inspection._tag}`);
      const normalizedInspection =
        inspection._tag === "Conflict"
          ? {
              _tag: "Failed" as const,
              cohortId: identity.cohortId,
              dispatchId: identity.dispatchId,
              executionId: identity.executionId,
              failureChecksum: qualificationChecksum({
                cohortArtifactChecksum: frozen.cohortArtifactChecksum,
                cohortId: identity.cohortId,
                executionId: identity.executionId,
                reason: "settledAuthorityConflict",
              }),
              manifestChecksum: input.invocation.manifestChecksum,
              planChecksum: input.invocation.planChecksum,
              sourceVersion: frozen.manifest.sourceVersion,
            }
          : inspection;
      const finalizationInputChecksum = qualificationChecksum({
        cohortArtifactChecksum: frozen.cohortArtifactChecksum,
        cohortArtifactId: frozen.cohortArtifactId,
        cohortId: identity.cohortId,
        executionId: identity.executionId,
        inspection: normalizedInspection,
        ownerRequestChecksum: input.invocation.requestArtifactChecksum,
        preCompletionChecksum: completionMaterial.completion.checksum,
        preReportChecksum: report.checksum,
        preResponseChecksum: responseSha,
      });
      yield* pinExact(finalizationInputChecksum, input.invocation.requestArtifactId);
      const lineage = {
        executionId: identity.executionId,
        manifestChecksum: input.invocation.manifestChecksum,
        ownerRequestChecksum: input.invocation.requestArtifactChecksum,
        planChecksum: input.invocation.planChecksum,
        preTeardownCompletionChecksum: completionMaterial.completion.checksum,
        preTeardownReportChecksum: report.checksum,
        preTeardownResponseChecksum: responseSha,
        sourceVersion: frozen.manifest.sourceVersion,
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
        preTeardownCompletionArtifactId: completionMaterial.completion.artifactId,
        preTeardownCompletionChecksum: completionMaterial.completion.checksum,
        preTeardownReport: report,
        preTeardownResponseArtifactId: responseId,
        preTeardownResponseChecksum: responseSha,
        teardownReceipt: receipt,
      });
      const completion = qualificationPostTeardownCompletion(postReport);
      const postResponse = qualificationPostTeardownResponse(postReport, completion);
      const artifacts: ReadonlyArray<PostArtifact> = [
        {
          artifactId: qualificationPostTeardownReceiptArtifactId(identity.executionId),
          checksum: receipt.checksum,
          kind: "qualification-post-teardown-evaluation-receipt-v1",
          stage: "receipt",
          value: receipt,
        },
        {
          artifactId: qualificationPostTeardownReportArtifactId(identity.executionId),
          checksum: postReport.checksum,
          kind: "qualification-post-teardown-evaluation-report-v1",
          stage: "report",
          value: postReport,
        },
        {
          artifactId: qualificationPostTeardownCompletionArtifactId(identity.executionId),
          checksum: completion.checksum,
          kind: "qualification-post-teardown-evaluation-completion-v1",
          stage: "completion",
          value: completion,
        },
        {
          artifactId: qualificationPostTeardownResponseArtifactId(identity.executionId),
          checksum: qualificationChecksum(postResponse),
          kind: "qualification-post-teardown-owner-response-v1",
          stage: "response",
          value: postResponse,
        },
      ];
      const settleCollision = (artifact: PostArtifact) =>
        Effect.gen(function* () {
          const marker = makeStageConflict({
            artifact,
            completion,
            inputChecksum: finalizationInputChecksum,
            ownerRequestChecksum: input.invocation.requestArtifactChecksum,
            preCompletionChecksum: completionMaterial.completion.checksum,
            preReportChecksum: report.checksum,
            preResponseChecksum: responseSha,
            receipt,
            report: postReport,
          });
          const markerArtifact: PostArtifact = {
            artifactId: qualificationPostTeardownConflictArtifactId(identity.executionId),
            checksum: marker.checksum,
            kind: "qualification-post-teardown-evaluation-conflict-v1",
            stage: "conflict",
            value: marker,
          };
          const markerResult = yield* Effect.tryPromise({
            try: () =>
              retainArtifact(
                input.bucket,
                markerArtifact,
                identity.executionId,
                finalizationInputChecksum,
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
                finalizationInputChecksum,
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
              finalizationInputChecksum,
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

      const retainedMarker = yield* get(
        qualificationPostTeardownConflictArtifactId(identity.executionId),
      );
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
          const artifactId = qualificationPostTeardownConflictArtifactId(identity.executionId);
          const conflictChecksum = qualificationChecksum({
            artifactId,
            executionId: identity.executionId,
            reason: "POST conflict marker is malformed",
          });
          yield* mutationApplied(
            yield* input.publication.retainConflict(
              identity,
              input.claim.claimToken,
              finalizationInputChecksum,
              conflictChecksum,
            ),
            artifactId,
          );
          return yield* Effect.fail(
            new QualificationPostTeardownFinalizationConflict({
              artifactId,
              message: "POST conflict marker is malformed",
            }),
          );
        }
        const target = artifacts.find(({ stage }) => stage === retainedConflict.stage);
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
              finalizationInputChecksum,
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
          completion,
          inputChecksum: finalizationInputChecksum,
          ownerRequestChecksum: input.invocation.requestArtifactChecksum,
          preCompletionChecksum: completionMaterial.completion.checksum,
          preReportChecksum: report.checksum,
          preResponseChecksum: responseSha,
          receipt,
          report: postReport,
        });
        const expectedArtifact: PostArtifact = {
          artifactId: expected.artifactId,
          checksum: expected.checksum,
          kind: "qualification-post-teardown-evaluation-conflict-v1",
          stage: "conflict",
          value: expected,
        };
        const authenticated = yield* Effect.tryPromise({
          try: () =>
            authenticateArtifact(
              input.bucket,
              expectedArtifact,
              identity.executionId,
              finalizationInputChecksum,
            ),
          catch: (cause) =>
            new QualificationPostTeardownFinalizationUnavailable({
              cause,
              operation: "authenticate:conflict",
            }),
        });
        if (authenticated !== "EXACT") {
          const conflictChecksum = qualificationChecksum({
            artifactId: retainedConflict.artifactId,
            executionId: identity.executionId,
            reason: "POST conflict marker conflicts",
          });
          yield* mutationApplied(
            yield* input.publication.retainConflict(
              identity,
              input.claim.claimToken,
              finalizationInputChecksum,
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
            finalizationInputChecksum,
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
      for (const artifact of artifacts)
        initialStates.push(
          yield* Effect.tryPromise({
            try: () =>
              authenticateArtifact(
                input.bucket,
                artifact,
                identity.executionId,
                finalizationInputChecksum,
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
      const conflictingArtifact = artifacts[firstConflict];
      if (conflictingArtifact !== undefined) return yield* settleCollision(conflictingArtifact);
      if (
        firstAbsent >= 0 &&
        initialStates.slice(firstAbsent + 1).some((state) => state === "EXACT")
      ) {
        const missingPredecessor = artifacts[firstAbsent];
        if (missingPredecessor !== undefined) return yield* settleCollision(missingPredecessor);
      }
      for (const artifact of artifacts) {
        const result = yield* Effect.tryPromise({
          try: () =>
            retainArtifact(input.bucket, artifact, identity.executionId, finalizationInputChecksum),
          catch: (cause) =>
            new QualificationPostTeardownFinalizationUnavailable({
              cause,
              operation: `retain:${artifact.stage}`,
            }),
        });
        if (result === "EXACT") continue;
        return yield* settleCollision(artifact);
      }
      const chainChecksum = qualificationChecksum({
        completionChecksum: completion.checksum,
        reportChecksum: postReport.checksum,
        responseChecksum: qualificationChecksum(postResponse),
        teardownReceiptChecksum: receipt.checksum,
      });
      yield* mutationApplied(
        yield* input.publication.publish(
          identity,
          input.claim.claimToken,
          finalizationInputChecksum,
          chainChecksum,
        ),
        qualificationPostTeardownResponseArtifactId(identity.executionId),
      );
      return { _tag: "Published", checksum: chainChecksum } as const;
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
