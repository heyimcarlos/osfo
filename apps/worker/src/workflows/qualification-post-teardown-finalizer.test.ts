/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/prefer-schema-over-json, eslint/no-underscore-dangle, vitest/no-standalone-expect -- Effect Vitest generators and Promise fakes model the R2 boundary. */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { manifestVersions } from "../../test/support/qualification-fixtures";
import { qualificationAuthoritySources } from "../qualification/authority-sources";
import {
  qualificationDistributedEvaluationReport,
  qualificationDistributedEvaluationReportArtifactId,
  qualificationDistributedEvaluationReportCompletion,
  qualificationDistributedEvaluationReportCompletionArtifactId,
} from "../qualification/distributed-evaluation-report";
import { createQualificationExecutionPlan } from "../qualification/execution";
import { qualificationExecutionRunCorpusReceipt } from "../qualification/execution-run-corpus";
import {
  qualificationCorrectnessRootReceiptArtifactId,
  qualificationOwnerDimensionCoordinatorBudget,
} from "../qualification/owner-partitions";
import {
  qualificationPostTeardownCompletionArtifactId,
  qualificationPostTeardownConflictArtifactId,
  qualificationPostTeardownReceiptArtifactId,
  qualificationPostTeardownReportArtifactId,
  qualificationPostTeardownResponseArtifactId,
} from "../qualification/post-teardown-evaluation";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import { createBoundedBetaManifest } from "../qualification/qualification-manifest";
import {
  type QualificationPostTeardownAuthorityInspection,
  type QualificationPostTeardownPublicationClaim,
  type QualificationPostTeardownPublicationIdentity,
  QualificationPostTeardownPublicationUnavailable,
} from "../integrations/postgres/qualification-post-teardown";
import {
  finalizeQualificationPostTeardown,
  qualificationPostTeardownTerminalReplay,
  QualificationPostTeardownFinalizationConflict,
  type QualificationPostTeardownBucket,
  type QualificationPostTeardownPublicationPort,
} from "./qualification-post-teardown-finalizer";
import { qualificationDimensionCoordinatorCompletionArtifactId } from "./qualification-owner-dimensions";

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const fixture = async () => {
  const manifest = createBoundedBetaManifest(manifestVersions);
  const plan = createQualificationExecutionPlan(manifest, 0, "post-finalizer-test");
  const executionId = plan.executionId;
  const ownerContent = {
    authoritySources: qualificationAuthoritySources,
    cohortArtifactChecksum: "cohort-checksum",
    cohortArtifactId: `qualification/executions/${encodeURIComponent(executionId)}/cohort.json`,
    executionId,
    manifest,
    manifestChecksum: manifest.manifestChecksum,
    plan,
    planChecksum: plan.planChecksum,
    protocolVersion: "qualification-owner-v1" as const,
    shardRecordLimit: 256 as const,
  };
  const ownerRequest = { ...ownerContent, artifactChecksum: qualificationChecksum(ownerContent) };
  const ownerEncoded = canonicalQualificationJson(ownerRequest);
  const expectedRootCount = plan.runs.reduce((total, run) => total + run.arrivalCount, 0);
  const partitionCount = plan.runs.reduce(
    (total, run) => total + Math.ceil(run.arrivalCount / 256),
    0,
  );
  const corpusReceipt = qualificationExecutionRunCorpusReceipt({
    acceptedCount: expectedRootCount,
    completeOutcomeCount: partitionCount,
    completionCount: partitionCount,
    executionId,
    expectedRootCount,
    failOutcomeCount: 0,
    manifestChecksum: manifest.manifestChecksum,
    missingCompletionCount: 0,
    outcomeMissingCount: 0,
    pageCount: Math.ceil(partitionCount / 50),
    partitionCount,
    planChecksum: plan.planChecksum,
    rootCount: expectedRootCount,
    sourceVersion: manifest.sourceVersion,
    terminalJoinPageChecksum: "join-checksum",
    terminalLaunchPageChecksum: "launch-checksum",
    topologyVersion: manifest.topologyVersion,
  });
  const report = qualificationDistributedEvaluationReport({
    acceptanceLevel: manifest.acceptanceLevel,
    correctness: { reason: "correctness_missing", verdict: "MISSING" },
    dimensions: { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
    executionCorpus: {
      acceptedCount: expectedRootCount,
      artifactId: corpusReceipt.artifactId,
      checksum: corpusReceipt.checksum,
      completionCount: corpusReceipt.completionCount,
      pageCount: corpusReceipt.pageCount,
      partitionCount: corpusReceipt.partitionCount,
      rootCount: expectedRootCount,
      terminalJoinPageChecksum: "join-checksum",
      terminalLaunchPageChecksum: "launch-checksum",
    },
    executionId,
    expectedDimensionCount: qualificationOwnerDimensionCoordinatorBudget(plan).dimensionCount,
    expectedRootCount,
    manifestChecksum: manifest.manifestChecksum,
    planChecksum: plan.planChecksum,
    sourceVersion: manifest.sourceVersion,
    topologyVersion: manifest.topologyVersion,
  });
  const completion = qualificationDistributedEvaluationReportCompletion(report);
  const response = {
    body: {
      completionArtifactId: completion.artifactId,
      completionChecksum: completion.checksum,
      error: "qualificationAuthorityMaterialMissing",
      executionId,
      failingFamilies: [],
      manifestChecksum: manifest.manifestChecksum,
      missingFamilies: report.families
        .filter(({ verdict }) => verdict === "MISSING")
        .map(({ family }) => family),
      phase: "PRE_TEARDOWN" as const,
      planChecksum: plan.planChecksum,
      reportArtifactId: report.artifactId,
      reportChecksum: report.checksum,
      verdict: "MISSING" as const,
      version: "qualification-owner-response-v2" as const,
    },
    status: 424 as const,
  };
  const responseEncoded = canonicalQualificationJson(response);
  const values = new Map<
    string,
    {
      readonly body: string;
      readonly contentType: string;
      readonly metadata: Readonly<Record<string, string>>;
    }
  >();
  const seed = (key: string, body: string, metadata: Readonly<Record<string, string>>) =>
    values.set(key, { body, contentType: "application/json", metadata });
  seed(
    `qualification/executions/${encodeURIComponent(executionId)}/owner-request.json`,
    ownerEncoded,
    { "osfo-kind": "qualification-execution-v1" },
  );
  const corpusEncoded = canonicalQualificationJson(corpusReceipt);
  seed(corpusReceipt.artifactId, corpusEncoded, {
    "osfo-artifact-checksum": corpusReceipt.checksum,
    "osfo-body-sha256": await sha256Hex(corpusEncoded),
    "osfo-completion-count": String(corpusReceipt.completionCount),
    "osfo-execution-id": executionId,
    "osfo-expected-root-count": String(corpusReceipt.expectedRootCount),
    "osfo-kind": corpusReceipt.version,
    "osfo-manifest-checksum": corpusReceipt.manifestChecksum,
    "osfo-page-count": String(corpusReceipt.pageCount),
    "osfo-partition-count": String(corpusReceipt.partitionCount),
    "osfo-plan-checksum": corpusReceipt.planChecksum,
    "osfo-root-count": String(corpusReceipt.rootCount),
    "osfo-source-version": corpusReceipt.sourceVersion,
    "osfo-terminal-join-page-checksum": corpusReceipt.terminalJoinPageChecksum,
    "osfo-terminal-launch-page-checksum": corpusReceipt.terminalLaunchPageChecksum,
    "osfo-topology-version": corpusReceipt.topologyVersion,
  });
  const reportEncoded = canonicalQualificationJson(report);
  seed(qualificationDistributedEvaluationReportArtifactId(executionId), reportEncoded, {
    "osfo-artifact-checksum": report.checksum,
    "osfo-body-sha256": await sha256Hex(reportEncoded),
    "osfo-execution-id": executionId,
    "osfo-expected-dimension-count": String(report.expectedDimensionCount),
    "osfo-expected-root-count": String(report.expectedRootCount),
    "osfo-kind": "qualification-distributed-evaluation-report-v1",
    "osfo-manifest-checksum": report.manifestChecksum,
    "osfo-plan-checksum": report.planChecksum,
    "osfo-verdict": report.verdict,
  });
  const completionEncoded = canonicalQualificationJson(completion);
  seed(
    qualificationDistributedEvaluationReportCompletionArtifactId(executionId),
    completionEncoded,
    {
      "osfo-artifact-checksum": completion.checksum,
      "osfo-body-sha256": await sha256Hex(completionEncoded),
      "osfo-execution-id": executionId,
      "osfo-kind": "qualification-distributed-evaluation-report-completion-v1",
      "osfo-manifest-checksum": completion.manifestChecksum,
      "osfo-plan-checksum": completion.planChecksum,
      "osfo-report-checksum": completion.reportChecksum,
      "osfo-verdict": completion.verdict,
    },
  );
  seed(
    `qualification/executions/${encodeURIComponent(executionId)}/owner-response.json`,
    responseEncoded,
    {
      "osfo-body-sha256": await sha256Hex(responseEncoded),
      "osfo-execution-id": executionId,
      "osfo-kind": "qualification-owner-response-v2",
      "osfo-manifest-checksum": manifest.manifestChecksum,
      "osfo-plan-checksum": plan.planChecksum,
      "osfo-report-checksum": report.checksum,
      "osfo-verdict": report.verdict,
    },
  );
  let getCount = 0;
  let putCount = 0;
  const putCounts = new Map<string, number>();
  const lostPutResponses = new Set<string>();
  const rejectedPutResponses = new Set<string>();
  const bucket: QualificationPostTeardownBucket = {
    get: (key) => {
      getCount += 1;
      const retained = values.get(key);
      return Promise.resolve(
        retained === undefined
          ? null
          : {
              customMetadata: retained.metadata,
              httpMetadata: { contentType: retained.contentType },
              text: () => Promise.resolve(retained.body),
            },
      );
    },
    put: (key, body, options) => {
      putCount += 1;
      putCounts.set(key, (putCounts.get(key) ?? 0) + 1);
      if (values.has(key)) return Promise.resolve(null);
      values.set(key, {
        body,
        contentType: options.httpMetadata.contentType,
        metadata: options.customMetadata,
      });
      if (rejectedPutResponses.delete(key))
        return Promise.reject(new Error(`R2 rejected after committing ${key}`));
      return Promise.resolve(lostPutResponses.delete(key) ? null : { etag: "created" });
    },
  };
  const mutations = new Array<string>();
  const commitThenErrorMutations = new Set<"ineligible" | "publish">();
  let pinnedInputChecksum: string | null = null;
  let terminalClaim: Extract<
    QualificationPostTeardownPublicationClaim,
    { readonly _tag: "Terminal" }
  > | null = null;
  let inspection: QualificationPostTeardownAuthorityInspection = {
    _tag: "Ready",
    allocationIdentityCount: 0,
    artifactAuthorityProofChecksum: "proof-checksum",
    artifactAuthorityProtocol: "qualification-cohort-artifact-authority-v1",
    cohortArtifactChecksum: ownerContent.cohortArtifactChecksum,
    cohortArtifactId: ownerContent.cohortArtifactId,
    cohortId: "cohort",
    dispatchId: "dispatch",
    dispatchProtocolVersion: "qualification-cohort-scrub-dispatch-v1",
    executionId,
    expectedPageCount: 1,
    expectedParticipantCount: 1,
    finalPageChecksum: "page-checksum",
    manifestChecksum: manifest.manifestChecksum,
    planChecksum: plan.planChecksum,
    provisionIdentityCount: 0,
    qualificationRootAttemptCount: 0,
    rootChecksum: "root-checksum",
    rootInstanceId: "root-instance",
    sourceVersion: manifest.sourceVersion,
  };
  const applied = (name: string) => {
    mutations.push(name);
    return Effect.succeed({ _tag: "Applied" as const });
  };
  const settle =
    (name: "ineligible" | "publish", state: "INELIGIBLE" | "PUBLISHED") =>
    (
      _identity: QualificationPostTeardownPublicationIdentity,
      _token: string,
      inputChecksum: string,
      artifactChecksum: string,
    ) => {
      mutations.push(name);
      terminalClaim = {
        _tag: "Terminal",
        artifactChecksum,
        conflictChecksum: null,
        inputChecksum,
        state,
      };
      return commitThenErrorMutations.delete(name)
        ? Effect.fail(
            new QualificationPostTeardownPublicationUnavailable({
              cause: new Error(`${name} rejected after commit`),
              operation: name,
            }),
          )
        : Effect.succeed({ _tag: "Applied" as const });
    };
  const publication: QualificationPostTeardownPublicationPort = {
    inspectAuthority: () => Effect.succeed(inspection),
    pinInput: (_identity, _token, checksum) => {
      pinnedInputChecksum = checksum;
      return applied("pin");
    },
    publish: settle("publish", "PUBLISHED"),
    release: () => applied("release"),
    retainConflict: () => applied("conflict"),
    retainIneligible: settle("ineligible", "INELIGIBLE"),
  };
  return {
    bucket,
    claim: {
      _tag: "Claimed" as const,
      attemptCount: 1,
      claimToken: "token",
      cohortId: "cohort",
      dispatchId: "dispatch",
      executionId,
      inputChecksum: null,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      scrubState: "SETTLED" as const,
    },
    invocation: {
      executionId,
      manifestChecksum: manifest.manifestChecksum,
      planChecksum: plan.planChecksum,
      requestArtifactChecksum: ownerRequest.artifactChecksum,
      requestArtifactId: `qualification/executions/${encodeURIComponent(executionId)}/owner-request.json`,
    },
    corpusArtifactId: corpusReceipt.artifactId,
    expectedRootCount,
    commitThenErrorMutations,
    lostPutResponses,
    manifest,
    mutations,
    publication,
    putCountFor: (key: string) => putCounts.get(key) ?? 0,
    rejectedPutResponses,
    report,
    response,
    setInspection: (value: QualificationPostTeardownAuthorityInspection) => {
      inspection = value;
    },
    stats: () => ({ getCount, putCount }),
    terminal: () => terminalClaim,
    pinnedInput: () => pinnedInputChecksum,
    values,
  };
};
type FixtureState = Awaited<ReturnType<typeof fixture>>;
const replacePreChain = async (
  state: FixtureState,
  report: ReturnType<typeof qualificationDistributedEvaluationReport>,
) => {
  const completion = qualificationDistributedEvaluationReportCompletion(report);
  const reportEncoded = canonicalQualificationJson(report);
  state.values.set(report.artifactId, {
    body: reportEncoded,
    contentType: "application/json",
    metadata: {
      "osfo-artifact-checksum": report.checksum,
      "osfo-body-sha256": await sha256Hex(reportEncoded),
      "osfo-execution-id": report.executionId,
      "osfo-expected-dimension-count": String(report.expectedDimensionCount),
      "osfo-expected-root-count": String(report.expectedRootCount),
      "osfo-kind": report.version,
      "osfo-manifest-checksum": report.manifestChecksum,
      "osfo-plan-checksum": report.planChecksum,
      "osfo-verdict": report.verdict,
    },
  });
  const completionEncoded = canonicalQualificationJson(completion);
  state.values.set(completion.artifactId, {
    body: completionEncoded,
    contentType: "application/json",
    metadata: {
      "osfo-artifact-checksum": completion.checksum,
      "osfo-body-sha256": await sha256Hex(completionEncoded),
      "osfo-execution-id": completion.executionId,
      "osfo-kind": completion.version,
      "osfo-manifest-checksum": completion.manifestChecksum,
      "osfo-plan-checksum": completion.planChecksum,
      "osfo-report-checksum": completion.reportChecksum,
      "osfo-verdict": completion.verdict,
    },
  });
  const response = {
    ...state.response,
    body: {
      ...state.response.body,
      completionChecksum: completion.checksum,
      error:
        report.verdict === "FAIL"
          ? "qualificationAuthorityConflict"
          : "qualificationAuthorityMaterialMissing",
      failingFamilies: report.families
        .filter(({ verdict }) => verdict === "FAIL")
        .map(({ family }) => family),
      missingFamilies: report.families
        .filter(({ verdict }) => verdict === "MISSING")
        .map(({ family }) => family),
      reportChecksum: report.checksum,
      verdict: report.verdict,
    },
    status: report.verdict === "FAIL" ? (409 as const) : (424 as const),
  };
  const responseEncoded = canonicalQualificationJson(response);
  state.values.set(
    `qualification/executions/${encodeURIComponent(state.claim.executionId)}/owner-response.json`,
    {
      body: responseEncoded,
      contentType: "application/json",
      metadata: {
        "osfo-body-sha256": await sha256Hex(responseEncoded),
        "osfo-execution-id": state.claim.executionId,
        "osfo-kind": "qualification-owner-response-v2",
        "osfo-manifest-checksum": state.invocation.manifestChecksum,
        "osfo-plan-checksum": state.invocation.planChecksum,
        "osfo-report-checksum": report.checksum,
        "osfo-verdict": report.verdict,
      },
    },
  );
};
const replaceWithLegacyPreChain = async (state: FixtureState) => {
  const legacyCorpusContent = {
    failCount: 0,
    family: "execution_run_corpus" as const,
    missingCount: 1,
    reason: "authority_not_installed_pre_teardown",
    references: [],
    verdict: "MISSING" as const,
  };
  const families = state.report.families.map((family) =>
    family.family === "execution_run_corpus"
      ? { ...legacyCorpusContent, checksum: qualificationChecksum(legacyCorpusContent) }
      : family,
  );
  const { checksum: _currentChecksum, ...currentContent } = state.report;
  const legacyContent = {
    ...currentContent,
    families,
    missingFamilyCount: state.report.missingFamilyCount + 1,
  };
  const legacy = { ...legacyContent, checksum: qualificationChecksum(legacyContent) };
  await replacePreChain(state, legacy);
  return legacy;
};

describe("POST teardown finalizer", () => {
  it("accepts only an exact terminal publication replay", () => {
    const claim = {
      _tag: "Terminal" as const,
      artifactChecksum: "chain",
      conflictChecksum: null,
      inputChecksum: "input",
      state: "PUBLISHED" as const,
    };
    expect(qualificationPostTeardownTerminalReplay(claim, "input", "chain")).toEqual({
      _tag: "Published",
      checksum: "chain",
    });
    expect(() => qualificationPostTeardownTerminalReplay(claim, "changed", "chain")).toThrow(
      "Terminal publication replay conflicts",
    );
    expect(() =>
      qualificationPostTeardownTerminalReplay(
        { ...claim, artifactChecksum: null, conflictChecksum: "conflict", state: "CONFLICT" },
        "input",
        "chain",
      ),
    ).toThrow("Terminal publication replay conflicts");
  });

  it.effect("retains the exact PASS chain and replays it without writes", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      const first = yield* finalizeQualificationPostTeardown({
        ...state,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(first._tag).toBe("Published");
      expect(state.mutations).toEqual(["pin", "publish"]);
      expect(state.stats()).toEqual({ getCount: 11, putCount: 4 });
      const beforeReplay = state.stats();
      state.mutations.length = 0;
      const replay = yield* finalizeQualificationPostTeardown({
        ...state,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(replay).toEqual(first);
      expect(state.stats().putCount).toBe(beforeReplay.putCount);
      expect(state.stats().getCount - beforeReplay.getCount).toBe(11);
      expect(state.mutations).toEqual(["pin", "publish"]);
    }),
  );

  it.effect("releases missing authority without POST writes", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      state.setInspection({ _tag: "Pending" });
      const result = yield* finalizeQualificationPostTeardown({
        ...state,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(result._tag).toBe("Released");
      expect(state.stats()).toEqual({ getCount: 6, putCount: 0 });
      expect(state.mutations).toEqual(["release"]);
    }),
  );

  it.effect("retains the exact stage marker for every immutable collision", () =>
    Effect.gen(function* () {
      const stages = [
        ["receipt", qualificationPostTeardownReceiptArtifactId],
        ["report", qualificationPostTeardownReportArtifactId],
        ["completion", qualificationPostTeardownCompletionArtifactId],
        ["response", qualificationPostTeardownResponseArtifactId],
      ] as const;
      for (const [stage, artifactId] of stages) {
        const state = yield* Effect.promise(fixture);
        state.values.set(artifactId(state.claim.executionId), {
          body: "{}",
          contentType: "application/json",
          metadata: {},
        });
        const failure = yield* Effect.flip(
          finalizeQualificationPostTeardown({ ...state, releaseBackoffMilliseconds: 1_000 }),
        );
        expect(failure).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
        const marker = state.values.get(
          qualificationPostTeardownConflictArtifactId(state.claim.executionId),
        );
        expect(JSON.parse(marker?.body ?? "{}")).toMatchObject({ stage });
        expect(state.mutations).toEqual(["pin", "conflict"]);
        expect(state.stats()).toEqual({ getCount: 11, putCount: 1 });
      }
    }),
  );

  it.effect("materializes settled authority conflict as a FAIL chain", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      state.setInspection({ _tag: "Conflict" });
      const result = yield* finalizeQualificationPostTeardown({
        ...state,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(result._tag).toBe("Published");
      const response = state.values.get(
        qualificationPostTeardownResponseArtifactId(state.claim.executionId),
      );
      expect(response).toBeDefined();
      expect(JSON.parse(response?.body ?? "{}")).toMatchObject({
        body: { teardownVerdict: "FAIL", verdict: "FAIL" },
        status: 409,
      });
      expect(state.mutations).toEqual(["pin", "publish"]);
    }),
  );

  it.effect("rejects a later artifact without its exact predecessor", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      yield* finalizeQualificationPostTeardown({ ...state, releaseBackoffMilliseconds: 1_000 });
      state.values.delete(qualificationPostTeardownReceiptArtifactId(state.claim.executionId));
      state.mutations.length = 0;
      const failure = yield* Effect.flip(
        finalizeQualificationPostTeardown({ ...state, releaseBackoffMilliseconds: 1_000 }),
      );
      expect(failure).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
      expect(
        state.values.has(qualificationPostTeardownConflictArtifactId(state.claim.executionId)),
      ).toBe(true);
      expect(state.mutations).toEqual(["pin", "conflict"]);
    }),
  );

  it.effect("lets an exact conflict marker dominate later replay", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      state.values.set(qualificationPostTeardownResponseArtifactId(state.claim.executionId), {
        body: "{}",
        contentType: "application/json",
        metadata: {},
      });
      yield* Effect.flip(
        finalizeQualificationPostTeardown({ ...state, releaseBackoffMilliseconds: 1_000 }),
      );
      state.mutations.length = 0;
      const replay = yield* Effect.flip(
        finalizeQualificationPostTeardown({ ...state, releaseBackoffMilliseconds: 1_000 }),
      );
      expect(replay).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
      expect(state.mutations).toEqual(["pin", "conflict"]);
    }),
  );

  it.effect("resumes every canonical partial prefix without overwriting", () =>
    Effect.gen(function* () {
      const ids = [
        qualificationPostTeardownReceiptArtifactId,
        qualificationPostTeardownReportArtifactId,
        qualificationPostTeardownCompletionArtifactId,
        qualificationPostTeardownResponseArtifactId,
      ];
      for (let retainedCount = 0; retainedCount < ids.length; retainedCount += 1) {
        const state = yield* Effect.promise(fixture);
        yield* finalizeQualificationPostTeardown({ ...state, releaseBackoffMilliseconds: 1_000 });
        for (const id of ids.slice(retainedCount)) state.values.delete(id(state.claim.executionId));
        const before = state.stats().putCount;
        state.mutations.length = 0;
        const replay = yield* finalizeQualificationPostTeardown({
          ...state,
          releaseBackoffMilliseconds: 1_000,
        });
        expect(replay._tag).toBe("Published");
        expect(state.stats().putCount - before).toBe(ids.length - retainedCount);
        expect(
          state.values.has(qualificationPostTeardownConflictArtifactId(state.claim.executionId)),
        ).toBe(false);
      }
    }),
  );

  it.effect("releases the claim when R2 is transiently unavailable", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      const result = yield* finalizeQualificationPostTeardown({
        ...state,
        bucket: { ...state.bucket, get: () => Promise.reject(new Error("R2 unavailable")) },
        releaseBackoffMilliseconds: 1_000,
      });
      expect(result._tag).toBe("Released");
      expect(state.mutations).toEqual(["release"]);
    }),
  );

  it.effect("distinguishes missing from conflicting execution corpus authority", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.promise(fixture);
      missing.values.delete(missing.corpusArtifactId);
      const released = yield* finalizeQualificationPostTeardown({
        ...missing,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(released._tag).toBe("Released");
      expect(missing.mutations).toEqual(["release"]);

      const tampered = yield* Effect.promise(fixture);
      const corpus = tampered.values.get(tampered.corpusArtifactId);
      if (corpus === undefined) throw new Error("Expected corpus fixture");
      tampered.values.set(tampered.corpusArtifactId, {
        ...corpus,
        metadata: { ...corpus.metadata, "osfo-root-count": "0" },
      });
      const failure = yield* Effect.flip(
        finalizeQualificationPostTeardown({ ...tampered, releaseBackoffMilliseconds: 1_000 }),
      );
      expect(failure).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
      expect(tampered.mutations).toEqual(["pin", "conflict"]);
    }),
  );

  it.effect("settles a malformed frozen owner request as conflict", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      const retained = state.values.get(state.invocation.requestArtifactId);
      if (retained === undefined) throw new Error("Expected owner request fixture");
      state.values.set(state.invocation.requestArtifactId, { ...retained, body: "{}" });
      const failure = yield* Effect.flip(
        finalizeQualificationPostTeardown({ ...state, releaseBackoffMilliseconds: 1_000 }),
      );
      expect(failure).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
      expect(state.mutations).toEqual(["pin", "conflict"]);
      expect(state.stats().putCount).toBe(0);
    }),
  );

  it.effect("lets a retained PRE conflict marker dominate an otherwise exact chain", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      state.values.set(
        `qualification/executions/${encodeURIComponent(state.claim.executionId)}/distributed-report/pre-teardown-v1/conflict.json`,
        { body: "{}", contentType: "application/json", metadata: {} },
      );
      const failure = yield* Effect.flip(
        finalizeQualificationPostTeardown({ ...state, releaseBackoffMilliseconds: 1_000 }),
      );
      expect(failure).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
      expect(state.mutations).toEqual(["pin", "conflict"]);
      expect(state.stats()).toEqual({ getCount: 2, putCount: 0 });
    }),
  );

  it.effect("rejects every noncanonical PRE response summary field", () =>
    Effect.gen(function* () {
      const mutations = [
        (response: FixtureState["response"]) => ({
          ...response,
          body: { ...response.body, verdict: "FAIL" as const },
        }),
        (response: FixtureState["response"]) => ({ ...response, status: 409 as const }),
        (response: FixtureState["response"]) => ({
          ...response,
          body: { ...response.body, error: "qualificationAuthorityConflict" },
        }),
        (response: FixtureState["response"]) => ({
          ...response,
          body: { ...response.body, failingFamilies: ["cohort_teardown"] },
        }),
        (response: FixtureState["response"]) => ({
          ...response,
          body: { ...response.body, missingFamilies: [] },
        }),
      ];
      for (const mutate of mutations) {
        const state = yield* Effect.promise(fixture);
        const response = mutate(state.response);
        const encoded = canonicalQualificationJson(response);
        const key = `qualification/executions/${encodeURIComponent(state.claim.executionId)}/owner-response.json`;
        state.values.set(key, {
          body: encoded,
          contentType: "application/json",
          metadata: {
            "osfo-body-sha256": yield* Effect.promise(() => sha256Hex(encoded)),
            "osfo-execution-id": state.claim.executionId,
            "osfo-kind": "qualification-owner-response-v2",
            "osfo-manifest-checksum": state.invocation.manifestChecksum,
            "osfo-plan-checksum": state.invocation.planChecksum,
            "osfo-report-checksum": response.body.reportChecksum,
            "osfo-verdict": response.body.verdict,
          },
        });
        const failure = yield* Effect.flip(
          finalizeQualificationPostTeardown({ ...state, releaseBackoffMilliseconds: 1_000 }),
        );
        expect(failure).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
        expect(state.mutations).toEqual(["pin", "conflict"]);
        expect(state.stats().putCount).toBe(0);
      }
    }),
  );

  it.effect("resumes every committed R2 prefix after the PUT promise rejects", () =>
    Effect.gen(function* () {
      const postIds = [
        qualificationPostTeardownReceiptArtifactId,
        qualificationPostTeardownReportArtifactId,
        qualificationPostTeardownCompletionArtifactId,
        qualificationPostTeardownResponseArtifactId,
      ];
      for (const [stageIndex, postId] of postIds.entries()) {
        const state = yield* Effect.promise(fixture);
        const rejectedId = postId(state.claim.executionId);
        state.rejectedPutResponses.add(rejectedId);
        const first = yield* finalizeQualificationPostTeardown({
          ...state,
          releaseBackoffMilliseconds: 1_000,
        });
        expect(first._tag).toBe("Released");
        expect(state.mutations).toEqual(["pin", "release"]);
        for (const retainedId of postIds.slice(0, stageIndex + 1))
          expect(state.values.has(retainedId(state.claim.executionId))).toBe(true);
        for (const absentId of postIds.slice(stageIndex + 1))
          expect(state.values.has(absentId(state.claim.executionId))).toBe(false);
        const pinnedInput = state.pinnedInput();
        if (pinnedInput === null) throw new Error("Expected pinned finalization input");
        state.mutations.length = 0;
        const replay = yield* finalizeQualificationPostTeardown({
          ...state,
          claim: {
            ...state.claim,
            claimToken: `retry-${stageIndex}`,
            inputChecksum: pinnedInput,
          },
          releaseBackoffMilliseconds: 1_000,
        });
        expect(replay._tag).toBe("Published");
        for (const postArtifactId of postIds)
          expect(state.putCountFor(postArtifactId(state.claim.executionId))).toBe(1);
        expect(state.stats()).toEqual({ getCount: 22, putCount: 4 });
        expect(state.mutations).toEqual(["pin", "publish"]);
      }
    }),
  );

  it.effect("settles a committed conflict marker after its PUT promise rejects", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      state.values.set(qualificationPostTeardownResponseArtifactId(state.claim.executionId), {
        body: "{}",
        contentType: "application/json",
        metadata: {},
      });
      const conflictArtifactId = qualificationPostTeardownConflictArtifactId(
        state.claim.executionId,
      );
      state.rejectedPutResponses.add(conflictArtifactId);
      const first = yield* finalizeQualificationPostTeardown({
        ...state,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(first._tag).toBe("Released");
      expect(state.values.has(conflictArtifactId)).toBe(true);
      expect(state.mutations).toEqual(["pin", "release"]);
      const pinnedInput = state.pinnedInput();
      if (pinnedInput === null) throw new Error("Expected pinned finalization input");
      state.mutations.length = 0;
      const replay = yield* Effect.flip(
        finalizeQualificationPostTeardown({
          ...state,
          claim: {
            ...state.claim,
            claimToken: "conflict-marker-retry",
            inputChecksum: pinnedInput,
          },
          releaseBackoffMilliseconds: 1_000,
        }),
      );
      expect(replay).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
      expect(state.putCountFor(conflictArtifactId)).toBe(1);
      expect(state.stats()).toEqual({ getCount: 18, putCount: 1 });
      expect(state.mutations).toEqual(["pin", "conflict"]);
    }),
  );

  it.effect("reconciles null conditional races for every POST stage and conflict marker", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      const postIds = [
        qualificationPostTeardownReceiptArtifactId(state.claim.executionId),
        qualificationPostTeardownReportArtifactId(state.claim.executionId),
        qualificationPostTeardownCompletionArtifactId(state.claim.executionId),
        qualificationPostTeardownResponseArtifactId(state.claim.executionId),
      ];
      postIds.forEach((artifactId) => state.lostPutResponses.add(artifactId));
      const result = yield* finalizeQualificationPostTeardown({
        ...state,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(result._tag).toBe("Published");
      expect(state.mutations).toEqual(["pin", "publish"]);
      expect(state.stats()).toEqual({ getCount: 15, putCount: 4 });

      const collision = yield* Effect.promise(fixture);
      collision.values.set(
        qualificationPostTeardownResponseArtifactId(collision.claim.executionId),
        { body: "{}", contentType: "application/json", metadata: {} },
      );
      collision.lostPutResponses.add(
        qualificationPostTeardownConflictArtifactId(collision.claim.executionId),
      );
      const failure = yield* Effect.flip(
        finalizeQualificationPostTeardown({ ...collision, releaseBackoffMilliseconds: 1_000 }),
      );
      expect(failure).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
      expect(collision.stats()).toEqual({ getCount: 12, putCount: 1 });
      expect(collision.mutations).toEqual(["pin", "conflict"]);
    }),
  );

  it.effect("settles an exact pre-corpus PRE chain as INELIGIBLE without POST writes", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
      yield* Effect.promise(() => replaceWithLegacyPreChain(state));
      const result = yield* finalizeQualificationPostTeardown({
        ...state,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(result._tag).toBe("Ineligible");
      expect(state.mutations).toEqual(["pin", "ineligible"]);
      expect(state.stats()).toEqual({ getCount: 5, putCount: 0 });
    }),
  );

  it.effect("replays exact terminal state after publication commits and then errors", () =>
    Effect.gen(function* () {
      const published = yield* Effect.promise(fixture);
      published.commitThenErrorMutations.add("publish");
      const publishFailure = yield* Effect.flip(
        finalizeQualificationPostTeardown({
          ...published,
          releaseBackoffMilliseconds: 1_000,
        }),
      );
      expect(publishFailure).toBeInstanceOf(QualificationPostTeardownPublicationUnavailable);
      expect(published.mutations).toEqual(["pin", "publish"]);
      expect(published.stats()).toEqual({ getCount: 11, putCount: 4 });
      const publishedTerminal = published.terminal();
      if (publishedTerminal === null) throw new Error("Expected committed publication terminal");
      expect(
        qualificationPostTeardownTerminalReplay(
          publishedTerminal,
          publishedTerminal.inputChecksum,
          publishedTerminal.artifactChecksum ?? "",
        ),
      ).toEqual({ _tag: "Published", checksum: publishedTerminal.artifactChecksum });
      expect(() =>
        qualificationPostTeardownTerminalReplay(
          publishedTerminal,
          `${publishedTerminal.inputChecksum}-changed`,
          publishedTerminal.artifactChecksum ?? "",
        ),
      ).toThrow("Terminal publication replay conflicts");

      const ineligible = yield* Effect.promise(fixture);
      yield* Effect.promise(() => replaceWithLegacyPreChain(ineligible));
      ineligible.commitThenErrorMutations.add("ineligible");
      const ineligibleFailure = yield* Effect.flip(
        finalizeQualificationPostTeardown({
          ...ineligible,
          releaseBackoffMilliseconds: 1_000,
        }),
      );
      expect(ineligibleFailure).toBeInstanceOf(QualificationPostTeardownPublicationUnavailable);
      expect(ineligible.mutations).toEqual(["pin", "ineligible"]);
      expect(ineligible.stats()).toEqual({ getCount: 5, putCount: 0 });
      const ineligibleTerminal = ineligible.terminal();
      if (ineligibleTerminal === null) throw new Error("Expected committed ineligible terminal");
      expect(
        qualificationPostTeardownTerminalReplay(
          ineligibleTerminal,
          ineligibleTerminal.inputChecksum,
          ineligibleTerminal.artifactChecksum ?? "",
        ),
      ).toEqual({ _tag: "Ineligible", checksum: ineligibleTerminal.artifactChecksum });
      expect(() =>
        qualificationPostTeardownTerminalReplay(
          ineligibleTerminal,
          ineligibleTerminal.inputChecksum,
          `${ineligibleTerminal.artifactChecksum ?? ""}-changed`,
        ),
      ).toThrow("Terminal publication replay conflicts");
    }),
  );

  it.effect(
    "releases missing compact correctness and dimension references and conflicts on tamper",
    () =>
      Effect.gen(function* () {
        for (const kind of ["correctness", "dimensions"] as const) {
          const state = yield* Effect.promise(fixture);
          const corpusFamily = state.report.families.find(
            ({ family }) => family === "execution_run_corpus",
          );
          const corpus = corpusFamily?.references[0];
          if (corpus?.kind !== "executionCorpus") throw new Error("Expected corpus reference");
          const partitionCount = corpus.partitionCount;
          const referenceId =
            kind === "correctness"
              ? qualificationCorrectnessRootReceiptArtifactId(
                  state.claim.executionId,
                  partitionCount,
                )
              : qualificationDimensionCoordinatorCompletionArtifactId(state.claim.executionId);
          const report = qualificationDistributedEvaluationReport({
            acceptanceLevel: state.report.acceptanceLevel,
            correctness:
              kind === "correctness"
                ? {
                    acceptedCount: state.expectedRootCount,
                    artifactId: referenceId,
                    checksum: "compact-checksum",
                    failCount: 0,
                    missingCount: 0,
                    rootCount: state.expectedRootCount,
                    verdict: "PASS",
                  }
                : { reason: "correctness_missing", verdict: "MISSING" },
            dimensions:
              kind === "dimensions"
                ? {
                    artifactId: referenceId,
                    checksum: "compact-checksum",
                    dimensionCount: state.report.expectedDimensionCount,
                    failCount: 0,
                    missingCount: 0,
                    verdict: "PASS",
                  }
                : { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
            executionCorpus: corpus,
            executionId: state.claim.executionId,
            expectedDimensionCount: state.report.expectedDimensionCount,
            expectedRootCount: state.expectedRootCount,
            manifestChecksum: state.invocation.manifestChecksum,
            planChecksum: state.invocation.planChecksum,
            sourceVersion: state.report.sourceVersion,
            topologyVersion: state.report.topologyVersion,
          });
          yield* Effect.promise(() => replacePreChain(state, report));
          const missing = yield* finalizeQualificationPostTeardown({
            ...state,
            releaseBackoffMilliseconds: 1_000,
          });
          expect(missing._tag).toBe("Released");
          expect(state.mutations).toEqual(["release"]);

          const tampered = yield* Effect.promise(fixture);
          yield* Effect.promise(() => replacePreChain(tampered, report));
          tampered.values.set(referenceId, {
            body: "{}",
            contentType: "application/json",
            metadata: {},
          });
          const failure = yield* Effect.flip(
            finalizeQualificationPostTeardown({
              ...tampered,
              releaseBackoffMilliseconds: 1_000,
            }),
          );
          expect(failure).toBeInstanceOf(QualificationPostTeardownFinalizationConflict);
          expect(tampered.mutations).toEqual(["pin", "conflict"]);
        }
      }),
  );
});
