import { Option, Schema } from "effect";

import {
  ArtifactChecksum,
  EvidenceCount,
  QualificationId,
  QualificationUtcInstant,
} from "./evidence-primitives";
import { qualificationChecksum } from "./qualification-checksum";
import {
  assessmentFromFindings,
  type QualificationAssessment,
  type QualificationFinding,
} from "./verdict";

/** Semantic checkpoint whose evidence source changes as Supermemory catches up. */
export type MemorySemanticCheckpoint =
  | "beforeIndexing"
  | "afterIndexingBeforeDreaming"
  | "afterDreaming";

/** Required positive, negative, correction, association, and isolation assertion. */
export type MemorySemanticAssertion =
  | "assistantOnlyExcluded"
  | "correctionCurrent"
  | "crossUserIsolation"
  | "directUserFact"
  | "explicitConfirmationLearned"
  | "hypotheticalExcluded"
  | "quotedThirdPartyExcluded"
  | "rememberedPersonOpportunityAssociated";

export interface MemorySearchAttempt {
  readonly expectedSourceFound: boolean;
  readonly observedAtUtc: string;
}

/** Content-free observation correlated to committed local facts and retained provider evidence. */
export interface MemorySemanticObservation {
  readonly assertion: MemorySemanticAssertion;
  readonly authorityFactIds: ReadonlyArray<string>;
  readonly checkpoint: MemorySemanticCheckpoint;
  readonly containerConfiguredAtUtc: string;
  readonly containerTag: string;
  readonly documentId: string;
  readonly evidenceSource: "derivedMemory" | "indexedSource" | "profile" | "recentUnindexed";
  readonly expected: "absent" | "present";
  readonly isolationContainerTag?: string;
  readonly observationId: string;
  readonly observed: "absent" | "present";
  readonly observedAtUtc: string;
  readonly providerDoneAtUtc: string;
  readonly searchAttempts: ReadonlyArray<MemorySearchAttempt>;
  readonly sessionId: string;
  readonly snapshotAcceptedAtUtc: string;
  readonly tagCount: number;
}

/** Frozen, privacy-safe evidence from one clean live MemoryProvider qualification. */
export interface MemorySemanticEvidence {
  readonly artifactChecksum: string;
  readonly artifactId: string;
  readonly boundedRecall?: {
    readonly authorityFactIds: ReadonlyArray<string>;
    readonly deadlineMs: number;
    readonly elapsedMs: number;
    readonly expectedSourceFound: boolean;
    readonly profileExhausted: boolean;
  };
  readonly containerConfiguration?: {
    readonly method: "PATCH";
    readonly path: "/v3/container-tags/{tag}";
    readonly role: "admin";
  };
  readonly configurationVersion: string;
  readonly observations: ReadonlyArray<MemorySemanticObservation>;
  readonly providerVersion: string;
  readonly sourceVersion: string;
  readonly teardown: {
    readonly containerDeleted: boolean;
    readonly remainingDocuments: number;
  };
}

const MemorySearchAttemptBoundary = Schema.Struct({
  expectedSourceFound: Schema.Boolean,
  observedAtUtc: QualificationUtcInstant,
});

const MemorySemanticObservationBoundary = Schema.Struct({
  assertion: Schema.Literals([
    "assistantOnlyExcluded",
    "correctionCurrent",
    "crossUserIsolation",
    "directUserFact",
    "explicitConfirmationLearned",
    "hypotheticalExcluded",
    "quotedThirdPartyExcluded",
    "rememberedPersonOpportunityAssociated",
  ]),
  authorityFactIds: Schema.Array(QualificationId),
  checkpoint: Schema.Literals(["beforeIndexing", "afterIndexingBeforeDreaming", "afterDreaming"]),
  containerConfiguredAtUtc: QualificationUtcInstant,
  containerTag: QualificationId,
  documentId: QualificationId,
  evidenceSource: Schema.Literals(["derivedMemory", "indexedSource", "profile", "recentUnindexed"]),
  expected: Schema.Literals(["absent", "present"]),
  isolationContainerTag: Schema.optionalKey(QualificationId),
  observationId: QualificationId,
  observed: Schema.Literals(["absent", "present"]),
  observedAtUtc: QualificationUtcInstant,
  providerDoneAtUtc: QualificationUtcInstant,
  searchAttempts: Schema.Array(MemorySearchAttemptBoundary),
  sessionId: QualificationId,
  snapshotAcceptedAtUtc: QualificationUtcInstant,
  tagCount: EvidenceCount,
});

const MemorySemanticEvidenceBoundary = Schema.Struct({
  artifactChecksum: ArtifactChecksum,
  artifactId: QualificationId,
  boundedRecall: Schema.optionalKey(
    Schema.Struct({
      authorityFactIds: Schema.Array(QualificationId),
      deadlineMs: EvidenceCount,
      elapsedMs: EvidenceCount,
      expectedSourceFound: Schema.Boolean,
      profileExhausted: Schema.Boolean,
    }),
  ),
  containerConfiguration: Schema.optionalKey(
    Schema.Struct({
      method: Schema.Literal("PATCH"),
      path: Schema.Literal("/v3/container-tags/{tag}"),
      role: Schema.Literal("admin"),
    }),
  ),
  configurationVersion: QualificationId,
  observations: Schema.Array(MemorySemanticObservationBoundary),
  providerVersion: QualificationId,
  sourceVersion: QualificationId,
  teardown: Schema.Struct({
    containerDeleted: Schema.Boolean,
    remainingDocuments: EvidenceCount,
  }),
});

const requiredObservations: ReadonlyArray<
  readonly [MemorySemanticCheckpoint, MemorySemanticAssertion]
> = [
  ["beforeIndexing", "correctionCurrent"],
  ["afterIndexingBeforeDreaming", "directUserFact"],
  ["afterIndexingBeforeDreaming", "correctionCurrent"],
  ["afterIndexingBeforeDreaming", "crossUserIsolation"],
  ["afterDreaming", "correctionCurrent"],
  ["afterDreaming", "explicitConfirmationLearned"],
  ["afterDreaming", "rememberedPersonOpportunityAssociated"],
  ["afterDreaming", "assistantOnlyExcluded"],
  ["afterDreaming", "hypotheticalExcluded"],
  ["afterDreaming", "quotedThirdPartyExcluded"],
];

const expectedSource = (
  checkpoint: MemorySemanticCheckpoint,
): MemorySemanticObservation["evidenceSource"] =>
  checkpoint === "beforeIndexing"
    ? "recentUnindexed"
    : checkpoint === "afterIndexingBeforeDreaming"
      ? "indexedSource"
      : "derivedMemory";

/** Assess #264's retained semantic matrix without letting telemetry stand in for product facts. */
export const assessMemorySemanticEvidence = (
  unknownEvidence: MemorySemanticEvidence,
): QualificationAssessment => {
  const findings: Array<QualificationFinding> = [];
  const evidence = Option.getOrUndefined(
    Schema.decodeOption(MemorySemanticEvidenceBoundary)(unknownEvidence),
  );
  if (evidence === undefined) {
    return assessmentFromFindings([
      {
        code: "memorySemanticEvidenceInvalid",
        detail: "Memory semantic evidence failed its refined boundary parser",
        subject: "memorySemanticEvidence",
        verdict: "FAIL",
      },
    ]);
  }

  const { artifactChecksum, ...content } = evidence;
  if (artifactChecksum !== qualificationChecksum(content)) {
    findings.push({
      code: "memorySemanticChecksumMismatch",
      detail: "Memory semantic evidence does not match its frozen checksum",
      subject: evidence.artifactId,
      verdict: "FAIL",
    });
  }

  if (evidence.containerConfiguration === undefined) {
    findings.push({
      code: "memoryContainerConfigurationMissing",
      detail: "Memory evidence omits the pre-ingest admin container configuration request",
      subject: evidence.artifactId,
      verdict: "MISSING",
    });
  }
  if (evidence.boundedRecall === undefined) {
    findings.push({
      code: "memoryBoundedRecallMissing",
      detail: "Memory evidence omits exhausted profile-plus-query recall",
      subject: evidence.artifactId,
      verdict: "MISSING",
    });
  } else if (evidence.boundedRecall.authorityFactIds.length === 0) {
    findings.push({
      code: "memoryBoundedRecallAuthorityMissing",
      detail: "Bounded recall has no committed local authority fact",
      subject: evidence.artifactId,
      verdict: "MISSING",
    });
  } else if (
    evidence.boundedRecall.deadlineMs !== 750 ||
    evidence.boundedRecall.elapsedMs > evidence.boundedRecall.deadlineMs ||
    !evidence.boundedRecall.profileExhausted ||
    !evidence.boundedRecall.expectedSourceFound
  ) {
    findings.push({
      code: "memoryBoundedRecallFailed",
      detail:
        "Exhausted profile-plus-query recall did not succeed within the frozen 750 ms deadline",
      subject: evidence.artifactId,
      verdict: "FAIL",
    });
  }

  const recordsByKey = new Map<string, ReadonlyArray<MemorySemanticObservation>>();
  for (const record of evidence.observations) {
    const key = `${record.checkpoint}:${record.assertion}`;
    recordsByKey.set(key, [...(recordsByKey.get(key) ?? []), record]);
  }
  for (const [checkpoint, assertion] of requiredObservations) {
    const key = `${checkpoint}:${assertion}`;
    const records = recordsByKey.get(key) ?? [];
    if (records.length === 0) {
      findings.push({
        code: "memorySemanticObservationMissing",
        detail: `${key} has no retained observation`,
        subject: key,
        verdict: "MISSING",
      });
    } else if (records.length > 1) {
      findings.push({
        code: "memorySemanticObservationDuplicate",
        detail: `${key} has ${records.length} retained observations`,
        subject: key,
        verdict: "FAIL",
      });
    }
  }

  const observationIds = new Set<string>();
  for (const observation of evidence.observations) {
    const subject = `${observation.checkpoint}:${observation.assertion}`;
    if (observationIds.has(observation.observationId)) {
      findings.push({
        code: "memorySemanticObservationIdentityDuplicate",
        detail: `${observation.observationId} identifies more than one observation`,
        subject,
        verdict: "FAIL",
      });
    }
    observationIds.add(observation.observationId);

    if (observation.authorityFactIds.length === 0) {
      findings.push({
        code: "memorySemanticAuthorityMissing",
        detail: `${subject} has no committed local authority fact`,
        subject,
        verdict: "MISSING",
      });
    } else if (new Set(observation.authorityFactIds).size !== observation.authorityFactIds.length) {
      findings.push({
        code: "memorySemanticAuthorityInvalid",
        detail: `${subject} repeats a local authority fact`,
        subject,
        verdict: "FAIL",
      });
    }

    const configuredAt = Date.parse(observation.containerConfiguredAtUtc);
    const acceptedAt = Date.parse(observation.snapshotAcceptedAtUtc);
    const doneAt = Date.parse(observation.providerDoneAtUtc);
    const observedAt = Date.parse(observation.observedAtUtc);
    if (
      observation.tagCount !== 1 ||
      configuredAt > acceptedAt ||
      (observation.checkpoint === "beforeIndexing" && observedAt >= doneAt) ||
      (observation.checkpoint !== "beforeIndexing" && observedAt < doneAt)
    ) {
      findings.push({
        code: "memorySemanticOrderingInvalid",
        detail: `${subject} violates pre-ingest configuration or checkpoint ordering`,
        subject,
        verdict: "FAIL",
      });
    }

    if (observation.evidenceSource !== expectedSource(observation.checkpoint)) {
      findings.push({
        code: "memorySemanticSourceInvalid",
        detail: `${subject} used ${observation.evidenceSource} evidence`,
        subject,
        verdict: "FAIL",
      });
    }
    if (observation.expected !== observation.observed) {
      findings.push({
        code: "memorySemanticAssertionFailed",
        detail: `${subject} expected ${observation.expected} but observed ${observation.observed}`,
        subject,
        verdict: "FAIL",
      });
    }

    if (observation.assertion === "crossUserIsolation") {
      if (
        observation.isolationContainerTag === undefined ||
        observation.isolationContainerTag === observation.containerTag
      ) {
        findings.push({
          code: "memoryCrossUserEvidenceInvalid",
          detail: "Cross-User isolation did not use a distinct User container",
          subject,
          verdict: "FAIL",
        });
      }
    } else if (observation.isolationContainerTag !== undefined) {
      findings.push({
        code: "memoryIsolationContainerUnexpected",
        detail: `${subject} unexpectedly names an isolation container`,
        subject,
        verdict: "FAIL",
      });
    }

    if (observation.evidenceSource === "indexedSource") {
      const afterDone = observation.searchAttempts.filter(
        ({ observedAtUtc }) => Date.parse(observedAtUtc) > doneAt,
      );
      if (
        afterDone.length === 0 ||
        !afterDone.some(({ expectedSourceFound }) => expectedSourceFound)
      ) {
        findings.push({
          code: "memorySearchReadinessMissing",
          detail: `${subject} has no successful source-search poll after provider done`,
          subject,
          verdict: "MISSING",
        });
      }
    } else if (observation.searchAttempts.length > 0) {
      findings.push({
        code: "memorySearchEvidenceUnexpected",
        detail: `${subject} attaches source-search evidence to ${observation.evidenceSource}`,
        subject,
        verdict: "FAIL",
      });
    }
  }

  const primaryTags = new Set(evidence.observations.map(({ containerTag }) => containerTag));
  const sessionDocuments = new Map<string, Set<string>>();
  for (const observation of evidence.observations) {
    const documents = sessionDocuments.get(observation.sessionId) ?? new Set<string>();
    documents.add(observation.documentId);
    sessionDocuments.set(observation.sessionId, documents);
  }
  if (
    evidence.observations.length > 0 &&
    (primaryTags.size !== 1 ||
      [...sessionDocuments.values()].some((documents) => documents.size !== 1))
  ) {
    findings.push({
      code: "memoryProviderIdentityUnstable",
      detail: "Memory semantic evidence does not retain one User tag and one document per Session",
      subject: evidence.artifactId,
      verdict: "FAIL",
    });
  }

  if (!evidence.teardown.containerDeleted || evidence.teardown.remainingDocuments !== 0) {
    findings.push({
      code: "memorySemanticTeardownFailed",
      detail: "Disposable semantic qualification data was not fully deleted",
      subject: evidence.artifactId,
      verdict: "FAIL",
    });
  }
  return assessmentFromFindings(findings);
};
