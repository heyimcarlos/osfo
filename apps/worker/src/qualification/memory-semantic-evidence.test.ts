import { describe, expect, it } from "@effect/vitest";

import {
  completeMemorySemanticEvidence,
  withMemorySemanticObservations,
} from "../../test/support/memory-semantic-fixture";
import { qualificationChecksum } from "./qualification-checksum";
import { assessMemorySemanticEvidence } from "./memory-semantic-evidence";

describe("Memory semantic qualification", () => {
  it("passes the retained correction, extraction, isolation, and search-readiness matrix", () => {
    expect(assessMemorySemanticEvidence(completeMemorySemanticEvidence())).toEqual({
      findings: [],
      verdict: "PASS",
    });
  });

  it("keeps absent phases and telemetry-only observations MISSING", () => {
    const evidence = completeMemorySemanticEvidence();
    const observations = evidence.observations
      .filter(({ checkpoint }) => checkpoint !== "afterDreaming")
      .map((observation, index) =>
        index === 0 ? Object.assign({}, observation, { authorityFactIds: [] }) : observation,
      );

    expect(
      assessMemorySemanticEvidence(withMemorySemanticObservations(evidence, observations)),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "memorySemanticObservationMissing", verdict: "MISSING" }),
        expect.objectContaining({ code: "memorySemanticAuthorityMissing", verdict: "MISSING" }),
      ]),
      verdict: "MISSING",
    });
  });

  it("fails a learned negative claim and refuses done as a search barrier", () => {
    const evidence = completeMemorySemanticEvidence();
    const observations = evidence.observations.map((observation) => {
      if (observation.assertion === "quotedThirdPartyExcluded") {
        return { ...observation, observed: "present" as const };
      }
      if (
        observation.assertion === "correctionCurrent" &&
        observation.checkpoint === "afterIndexingBeforeDreaming"
      ) {
        return {
          ...observation,
          searchAttempts: observation.searchAttempts.map((attempt) => ({
            ...attempt,
            observedAtUtc: "2026-08-24T11:59:59.000Z",
          })),
        };
      }
      return observation;
    });

    expect(
      assessMemorySemanticEvidence(withMemorySemanticObservations(evidence, observations)),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "memorySemanticAssertionFailed", verdict: "FAIL" }),
        expect.objectContaining({ code: "memorySearchReadinessMissing", verdict: "MISSING" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects evidence that self-declares the wrong required outcome", () => {
    const evidence = completeMemorySemanticEvidence();
    const observations = evidence.observations.map((observation) =>
      observation.assertion === "correctionCurrent"
        ? { ...observation, expected: "absent" as const, observed: "absent" as const }
        : observation,
    );

    expect(
      assessMemorySemanticEvidence(withMemorySemanticObservations(evidence, observations)),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "memorySemanticExpectedOutcomeConflict",
          verdict: "FAIL",
        }),
      ]),
      verdict: "FAIL",
    });
  });

  it("requires the pre-ingest admin tag path and bounded exhausted recall", () => {
    const evidence = completeMemorySemanticEvidence();
    const {
      boundedRecall: _boundedRecall,
      containerConfiguration: _containerConfiguration,
      ...withoutProviderLessons
    } = evidence;
    const { artifactChecksum: _checksum, ...content } = withoutProviderLessons;
    expect(
      assessMemorySemanticEvidence({
        ...withoutProviderLessons,
        artifactChecksum: qualificationChecksum(content),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "memoryBoundedRecallMissing", verdict: "MISSING" }),
        expect.objectContaining({
          code: "memoryContainerConfigurationMissing",
          verdict: "MISSING",
        }),
      ]),
      verdict: "MISSING",
    });

    const boundedRecall = evidence.boundedRecall;
    expect(boundedRecall).toBeDefined();
    if (boundedRecall === undefined) return;
    const slow = { ...evidence, boundedRecall: { ...boundedRecall, elapsedMs: 751 } };
    const { artifactChecksum: _slowChecksum, ...slowContent } = slow;
    expect(
      assessMemorySemanticEvidence({
        ...slow,
        artifactChecksum: qualificationChecksum(slowContent),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "memoryBoundedRecallFailed", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("requires post-delete provider authority for the exact container and documents", () => {
    const evidence = completeMemorySemanticEvidence();
    const { authorityReceipt: _receipt, ...selfReportedTeardown } = evidence.teardown;
    const withoutReceipt = {
      ...evidence,
      teardown: selfReportedTeardown,
    };
    const { artifactChecksum: _checksum, ...withoutReceiptContent } = withoutReceipt;
    expect(
      assessMemorySemanticEvidence({
        ...withoutReceipt,
        artifactChecksum: qualificationChecksum(withoutReceiptContent),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "memorySemanticTeardownAuthorityMissing",
          verdict: "MISSING",
        }),
      ]),
      verdict: "MISSING",
    });

    const receipt = evidence.teardown.authorityReceipt;
    expect(receipt).toBeDefined();
    if (receipt === undefined) return;
    const { artifactChecksum: _receiptChecksum, ...receiptContent } = {
      ...receipt,
      remainingDocumentIds: ["document-1"],
    };
    const teardown = {
      ...evidence.teardown,
      authorityReceipt: {
        ...receiptContent,
        artifactChecksum: qualificationChecksum(receiptContent),
      },
    };
    const { artifactChecksum: _evidenceChecksum, ...content } = { ...evidence, teardown };
    expect(
      assessMemorySemanticEvidence({
        ...content,
        artifactChecksum: qualificationChecksum(content),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "memorySemanticTeardownAuthorityConflict",
          verdict: "FAIL",
        }),
      ]),
      verdict: "FAIL",
    });
  });
});
