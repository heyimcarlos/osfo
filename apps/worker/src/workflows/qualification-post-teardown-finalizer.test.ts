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
import { qualificationOwnerDimensionCoordinatorBudget } from "../qualification/owner-partitions";
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
import type { QualificationPostTeardownAuthorityInspection } from "../integrations/postgres/qualification-post-teardown";
import {
  finalizeQualificationPostTeardown,
  qualificationPostTeardownTerminalReplay,
  QualificationPostTeardownFinalizationConflict,
  type QualificationPostTeardownBucket,
  type QualificationPostTeardownPublicationPort,
} from "./qualification-post-teardown-finalizer";

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
  const lostPutResponses = new Set<string>();
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
      if (values.has(key)) return Promise.resolve(null);
      values.set(key, {
        body,
        contentType: options.httpMetadata.contentType,
        metadata: options.customMetadata,
      });
      return Promise.resolve(lostPutResponses.delete(key) ? null : { etag: "created" });
    },
  };
  const mutations = new Array<string>();
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
  const publication: QualificationPostTeardownPublicationPort = {
    inspectAuthority: () => Effect.succeed(inspection),
    pinInput: () => applied("pin"),
    publish: () => applied("publish"),
    release: () => applied("release"),
    retainConflict: () => applied("conflict"),
    retainIneligible: () => applied("ineligible"),
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
    lostPutResponses,
    manifest,
    mutations,
    publication,
    report,
    response,
    setInspection: (value: QualificationPostTeardownAuthorityInspection) => {
      inspection = value;
    },
    stats: () => ({ getCount, putCount }),
    values,
  };
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
      expect(state.stats()).toEqual({ getCount: 14, putCount: 4 });
      const beforeReplay = state.stats();
      state.mutations.length = 0;
      const replay = yield* finalizeQualificationPostTeardown({
        ...state,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(replay).toEqual(first);
      expect(state.stats().putCount).toBe(beforeReplay.putCount);
      expect(state.stats().getCount - beforeReplay.getCount).toBe(14);
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
      expect(state.stats()).toEqual({ getCount: 5, putCount: 0 });
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

  it.effect("reconciles lost create responses for every POST stage and the conflict marker", () =>
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
      expect(state.stats()).toEqual({ getCount: 18, putCount: 4 });

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
      expect(collision.mutations).toEqual(["pin", "conflict"]);
    }),
  );

  it.effect("settles an exact pre-corpus PRE chain as INELIGIBLE without POST writes", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(fixture);
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
      const completion = qualificationDistributedEvaluationReportCompletion(legacy);
      const reportEncoded = canonicalQualificationJson(legacy);
      state.values.set(legacy.artifactId, {
        body: reportEncoded,
        contentType: "application/json",
        metadata: {
          "osfo-artifact-checksum": legacy.checksum,
          "osfo-body-sha256": yield* Effect.promise(() => sha256Hex(reportEncoded)),
          "osfo-execution-id": legacy.executionId,
          "osfo-expected-dimension-count": String(legacy.expectedDimensionCount),
          "osfo-expected-root-count": String(legacy.expectedRootCount),
          "osfo-kind": legacy.version,
          "osfo-manifest-checksum": legacy.manifestChecksum,
          "osfo-plan-checksum": legacy.planChecksum,
          "osfo-verdict": legacy.verdict,
        },
      });
      const completionEncoded = canonicalQualificationJson(completion);
      state.values.set(completion.artifactId, {
        body: completionEncoded,
        contentType: "application/json",
        metadata: {
          "osfo-artifact-checksum": completion.checksum,
          "osfo-body-sha256": yield* Effect.promise(() => sha256Hex(completionEncoded)),
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
          missingFamilies: legacy.families
            .filter(({ verdict }) => verdict === "MISSING")
            .map(({ family }) => family),
          reportChecksum: legacy.checksum,
        },
      };
      const responseEncoded = canonicalQualificationJson(response);
      state.values.set(
        `qualification/executions/${encodeURIComponent(state.claim.executionId)}/owner-response.json`,
        {
          body: responseEncoded,
          contentType: "application/json",
          metadata: {
            "osfo-body-sha256": yield* Effect.promise(() => sha256Hex(responseEncoded)),
            "osfo-execution-id": state.claim.executionId,
            "osfo-kind": "qualification-owner-response-v2",
            "osfo-manifest-checksum": state.invocation.manifestChecksum,
            "osfo-plan-checksum": state.invocation.planChecksum,
            "osfo-report-checksum": legacy.checksum,
            "osfo-verdict": legacy.verdict,
          },
        },
      );
      const result = yield* finalizeQualificationPostTeardown({
        ...state,
        releaseBackoffMilliseconds: 1_000,
      });
      expect(result._tag).toBe("Ineligible");
      expect(state.mutations).toEqual(["pin", "ineligible"]);
      expect(state.stats().putCount).toBe(0);
    }),
  );
});
