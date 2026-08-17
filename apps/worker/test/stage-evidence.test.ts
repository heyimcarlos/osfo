import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";

import { qualificationChecksum } from "../src/qualification/qualification-checksum";
import { assessStageEvidence } from "../src/qualification/stage-evidence";
import {
  compactManifest,
  completeRunEvidence,
  completeStageMeasurements,
} from "./support/qualification-fixtures";

describe("Qualification stage evidence", () => {
  it("requires every stage and cold cause in every target, stress, and recovery repetition", () => {
    const manifest = compactManifest();
    const measurements = completeStageMeasurements(completeRunEvidence(manifest));
    expect(assessStageEvidence(manifest, measurements)).toMatchObject({
      findings: [],
      summaries: { length: 135 },
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
