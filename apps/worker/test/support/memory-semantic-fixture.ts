import type {
  MemorySemanticEvidence,
  MemorySemanticObservation,
} from "../../src/qualification/memory-semantic-evidence";
import { qualificationChecksum } from "../../src/qualification/qualification-checksum";

export const completeMemorySemanticEvidence = (
  sourceVersion = "source-1",
): MemorySemanticEvidence => {
  const common = {
    authorityFactIds: ["committed-turn-1", "memory-outbox-1"],
    containerConfiguredAtUtc: "2026-08-24T11:59:50.000Z",
    containerTag: "user-tag-1",
    documentId: "document-1",
    providerDoneAtUtc: "2026-08-24T12:00:10.000Z",
    sessionId: "session-1",
    snapshotAcceptedAtUtc: "2026-08-24T12:00:00.000Z",
    tagCount: 1,
  } as const;
  const indexedSearch = [
    { expectedSourceFound: false, observedAtUtc: "2026-08-24T12:00:10.100Z" },
    { expectedSourceFound: true, observedAtUtc: "2026-08-24T12:00:10.900Z" },
  ] as const;
  const observation = (
    input: Pick<
      MemorySemanticObservation,
      "assertion" | "checkpoint" | "evidenceSource" | "expected" | "observed"
    > & {
      readonly isolationContainerTag?: string;
      readonly searchAttempts?: MemorySemanticObservation["searchAttempts"];
    },
  ): MemorySemanticObservation => ({
    ...common,
    ...input,
    observationId: `${input.checkpoint}:${input.assertion}`,
    observedAtUtc:
      input.checkpoint === "beforeIndexing"
        ? "2026-08-24T12:00:05.000Z"
        : input.checkpoint === "afterIndexingBeforeDreaming"
          ? "2026-08-24T12:00:11.000Z"
          : "2026-08-24T12:06:00.000Z",
    searchAttempts: input.searchAttempts ?? [],
  });
  const observations: ReadonlyArray<MemorySemanticObservation> = [
    observation({
      assertion: "correctionCurrent",
      checkpoint: "beforeIndexing",
      evidenceSource: "recentUnindexed",
      expected: "present",
      observed: "present",
    }),
    observation({
      assertion: "directUserFact",
      checkpoint: "afterIndexingBeforeDreaming",
      evidenceSource: "indexedSource",
      expected: "present",
      observed: "present",
      searchAttempts: indexedSearch,
    }),
    observation({
      assertion: "correctionCurrent",
      checkpoint: "afterIndexingBeforeDreaming",
      evidenceSource: "indexedSource",
      expected: "present",
      observed: "present",
      searchAttempts: indexedSearch,
    }),
    observation({
      assertion: "crossUserIsolation",
      checkpoint: "afterIndexingBeforeDreaming",
      evidenceSource: "indexedSource",
      expected: "absent",
      isolationContainerTag: "user-tag-2",
      observed: "absent",
      searchAttempts: indexedSearch,
    }),
    ...(
      [
        ["correctionCurrent", "present", "present"],
        ["explicitConfirmationLearned", "present", "present"],
        ["rememberedPersonOpportunityAssociated", "present", "present"],
        ["assistantOnlyExcluded", "absent", "absent"],
        ["hypotheticalExcluded", "absent", "absent"],
        ["quotedThirdPartyExcluded", "absent", "absent"],
      ] as const
    ).map(([assertion, expected, observed]) =>
      observation({
        assertion,
        checkpoint: "afterDreaming",
        evidenceSource: "derivedMemory",
        expected,
        observed,
      }),
    ),
  ];
  const content = {
    artifactId: "memory-semantic-1",
    boundedRecall: {
      authorityFactIds: ["committed-turn-recall-1"],
      deadlineMs: 750,
      elapsedMs: 594,
      expectedSourceFound: true,
      profileExhausted: true,
    },
    containerConfiguration: {
      method: "PATCH" as const,
      path: "/v3/container-tags/{tag}" as const,
      role: "admin" as const,
    },
    configurationVersion: "memory-extraction-v1",
    observations,
    providerVersion: "supermemory-v4",
    sourceVersion,
    teardown: { containerDeleted: true, remainingDocuments: 0 },
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

export const withMemorySemanticObservations = (
  evidence: MemorySemanticEvidence,
  observations: ReadonlyArray<MemorySemanticObservation>,
): MemorySemanticEvidence => {
  let content: Omit<MemorySemanticEvidence, "artifactChecksum"> = {
    artifactId: evidence.artifactId,
    configurationVersion: evidence.configurationVersion,
    observations,
    providerVersion: evidence.providerVersion,
    sourceVersion: evidence.sourceVersion,
    teardown: evidence.teardown,
  };
  if (evidence.boundedRecall !== undefined) {
    content = { ...content, boundedRecall: evidence.boundedRecall };
  }
  if (evidence.containerConfiguration !== undefined) {
    content = { ...content, containerConfiguration: evidence.containerConfiguration };
  }
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};
