import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";

import { qualificationChecksum } from "./qualification-checksum";
import { assessStageEvidence } from "./stage-evidence";
import {
  compactManifest,
  completeRunEvidence,
  completeStageMeasurements,
} from "../../test/support/qualification-fixtures";

describe("Qualification stage evidence", () => {
  it("requires every stage and cold cause in target, stress, all-cold, and recovery runs", () => {
    const manifest = compactManifest();
    const measurements = completeStageMeasurements(completeRunEvidence(manifest));
    expect(assessStageEvidence(manifest, measurements)).toMatchObject({
      findings: [],
      summaries: { length: 139 },
      verdict: "PASS",
    });
    expect(
      assessStageEvidence(
        manifest,
        measurements.filter((_, index) => index !== 0),
      ),
    ).toMatchObject({
      findings: [expect.objectContaining({ code: "stageSplitMissing", verdict: "MISSING" })],
      verdict: "MISSING",
    });
  });

  it("fails a missed objective and a negative raw sample", () => {
    const manifest = compactManifest();
    const measurements = completeStageMeasurements(completeRunEvidence(manifest));
    expect(
      assessStageEvidence(
        manifest,
        measurements.map((measurement, index) =>
          index === 0
            ? (() => {
                const samples = measurement.samples.map((sample) =>
                  Object.assign({}, sample, {
                    endedAtUtc: DateTime.formatIso(
                      DateTime.makeUnsafe(Date.parse(sample.startedAtUtc) + 1_000_000),
                    ),
                    latencyMs: 1_000_000,
                  }),
                );
                return Object.assign({}, measurement, {
                  artifactChecksum: qualificationChecksum(samples),
                  samples,
                });
              })()
            : measurement,
        ),
      ),
    ).toMatchObject({
      findings: [expect.objectContaining({ code: "stageObjectiveMissed", verdict: "FAIL" })],
      verdict: "FAIL",
    });
    expect(
      assessStageEvidence(
        manifest,
        measurements.map((measurement, index) =>
          index === 0
            ? Object.assign({}, measurement, {
                samples: measurement.samples.map((sample, sampleIndex) =>
                  sampleIndex === 0 ? Object.assign({}, sample, { latencyMs: -1 }) : sample,
                ),
              })
            : measurement,
        ),
      ),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "stageEvidenceBoundaryInvalid", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("measures the all-cold lane directly for every activation cause", () => {
    const manifest = compactManifest();
    const measurements = completeStageMeasurements(completeRunEvidence(manifest));
    const allColdMeasurement = measurements.find(
      ({ lane, stage }) => lane === "allCold" && stage === "coldDurableAcceptance",
    );
    expect(allColdMeasurement).toBeDefined();
    if (allColdMeasurement === undefined) return;
    const samples = allColdMeasurement.samples.map((sample) => ({
      ...sample,
      endedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(sample.startedAtUtc) + 3_001)),
      latencyMs: 3_001,
    }));

    expect(
      assessStageEvidence(
        manifest,
        measurements.map((measurement) =>
          measurement === allColdMeasurement
            ? Object.assign({}, measurement, {
                artifactChecksum: qualificationChecksum(samples),
                samples,
              })
            : measurement,
        ),
      ),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "stageObjectiveMissed", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects duplicate evidence for one exact run split", () => {
    const manifest = compactManifest();
    const measurements = completeStageMeasurements(completeRunEvidence(manifest));
    expect(
      assessStageEvidence(
        manifest,
        measurements[0] === undefined ? measurements : [...measurements, measurements[0]],
      ),
    ).toMatchObject({
      findings: [expect.objectContaining({ code: "duplicateStageSplit", verdict: "FAIL" })],
      verdict: "FAIL",
    });
  });

  it("returns MISSING when a declared eligible root has no raw sample", () => {
    const manifest = compactManifest();
    const measurements = completeStageMeasurements(completeRunEvidence(manifest));
    expect(
      assessStageEvidence(
        manifest,
        measurements.map((measurement, index) =>
          index === 0
            ? (() => {
                const samples = measurement.samples.slice(1);
                return Object.assign({}, measurement, {
                  artifactChecksum: qualificationChecksum(samples),
                  samples,
                });
              })()
            : measurement,
        ),
      ),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "stageSampleMissing", verdict: "MISSING" }),
      ]),
      verdict: "MISSING",
    });
  });
});
