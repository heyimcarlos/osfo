import { Option, Schema } from "effect";

import {
  ArtifactChecksum,
  EvidenceCount,
  NonNegativeMeasurement,
  QualificationId,
  QualificationUtcInstant,
} from "./evidence-primitives";
import type { ProductionQualificationManifest } from "./qualification-manifest";
import { qualificationChecksum } from "./qualification-checksum";
import {
  assessmentFromFindings,
  type QualificationAssessment,
  type QualificationFinding,
} from "./verdict";

/** Maximum target-window use observed in one exact repetition. */
export interface ResourceUseMeasurement {
  readonly authorityArtifact?: {
    readonly artifactChecksum: string;
    readonly artifactId: string;
    readonly records: ReadonlyArray<{
      readonly authorityFactId: string;
      readonly observedAtUtc: string;
      readonly rootId: string;
      readonly value: number;
    }>;
    readonly runArtifactChecksum: string;
    readonly source: string;
    readonly sourceVersion: string;
  };
  readonly limitName: string;
  readonly maximumObserved: number;
  readonly region: ProductionQualificationManifest["regions"][number];
  readonly repetition: number;
  readonly runArtifactChecksum: string;
  readonly unit: string;
}

/** Parser for one run-bound hard-limit measurement. */
export const ResourceUseMeasurementBoundary = Schema.Struct({
  authorityArtifact: Schema.optionalKey(
    Schema.Struct({
      artifactChecksum: ArtifactChecksum,
      artifactId: QualificationId,
      records: Schema.Array(
        Schema.Struct({
          authorityFactId: QualificationId,
          observedAtUtc: QualificationUtcInstant,
          rootId: QualificationId,
          value: NonNegativeMeasurement,
        }),
      ),
      runArtifactChecksum: ArtifactChecksum,
      source: QualificationId,
      sourceVersion: QualificationId,
    }),
  ),
  limitName: QualificationId,
  maximumObserved: NonNegativeMeasurement,
  region: Schema.Literals(["americas", "asiaPacific", "europe"]),
  repetition: EvidenceCount,
  runArtifactChecksum: ArtifactChecksum,
  unit: QualificationId,
});

/** Assess at least 30 percent headroom in each target repetition and region. */
export const assessResourceHeadroom = (
  manifest: ProductionQualificationManifest,
  measurements: ReadonlyArray<ResourceUseMeasurement>,
): QualificationAssessment => {
  const findings: Array<QualificationFinding> = [];
  const parsedMeasurements = measurements.flatMap((measurement) =>
    Option.toArray(Schema.decodeOption(ResourceUseMeasurementBoundary)(measurement)),
  );
  if (parsedMeasurements.length !== measurements.length) {
    findings.push({
      code: "resourceEvidenceBoundaryInvalid",
      detail: "Resource evidence failed its refined boundary parser",
      subject: "resourceEvidence",
      verdict: "FAIL",
    });
  }
  const targetLane = manifest.lanes.find((lane) => lane.kind === "target");
  if (targetLane === undefined) {
    return assessmentFromFindings([
      {
        code: "targetLaneMissing",
        detail: "The frozen manifest has no target lane for resource headroom",
        subject: manifest.acceptanceLevel,
        verdict: "MISSING",
      },
    ]);
  }
  for (const region of manifest.regions) {
    for (let repetition = 1; repetition <= targetLane.repetitions; repetition += 1) {
      for (const limit of manifest.hardLimits) {
        const subject = `${limit.name}:${region}:${repetition}`;
        const matches = parsedMeasurements.filter(
          (candidate) =>
            candidate.limitName === limit.name &&
            candidate.region === region &&
            candidate.repetition === repetition,
        );
        if (matches.length > 1) {
          findings.push({
            code: "duplicateHardLimitMeasurement",
            detail: `${subject} has ${matches.length} target-use measurements`,
            subject,
            verdict: "FAIL",
          });
        }
        const measurement = matches[0];
        if (measurement === undefined) {
          findings.push({
            code: "hardLimitMeasurementMissing",
            detail: `${subject} has no target-use measurement`,
            subject,
            verdict: "MISSING",
          });
          continue;
        }
        if (measurement.unit !== limit.unit) {
          findings.push({
            code: "hardLimitUnitMismatch",
            detail: `${subject} was measured in ${measurement.unit}, expected ${limit.unit}`,
            subject,
            verdict: "MISSING",
          });
        } else if (measurement.authorityArtifact === undefined) {
          findings.push({
            code: "resourceAuthorityEvidenceMissing",
            detail: `${subject} has no retained raw resource authority artifact`,
            subject,
            verdict: "MISSING",
          });
        } else {
          const authority = measurement.authorityArtifact;
          const { artifactChecksum, ...content } = authority;
          const maximumObserved = authority.records.reduce(
            (maximum, record) => Math.max(maximum, record.value),
            0,
          );
          if (
            artifactChecksum !==
              qualificationChecksum({
                ...content,
                limitName: measurement.limitName,
                unit: measurement.unit,
              }) ||
            authority.records.length === 0 ||
            authority.runArtifactChecksum !== measurement.runArtifactChecksum ||
            authority.sourceVersion !== manifest.sourceVersion ||
            new Set(authority.records.map(({ authorityFactId }) => authorityFactId)).size !==
              authority.records.length
          ) {
            findings.push({
              code: "resourceAuthorityEvidenceInvalid",
              detail: `${subject} raw authority artifact is missing, duplicated, or checksum-conflicting`,
              subject,
              verdict: "FAIL",
            });
          } else if (measurement.maximumObserved !== maximumObserved) {
            findings.push({
              code: "resourceAuthorityMeasurementConflict",
              detail: `${subject} declares ${measurement.maximumObserved}; authority maximum is ${maximumObserved}`,
              subject,
              verdict: "FAIL",
            });
          } else if (
            !Number.isFinite(measurement.maximumObserved) ||
            measurement.maximumObserved < 0 ||
            measurement.runArtifactChecksum.length === 0 ||
            !Number.isFinite(limit.maximum) ||
            limit.maximum <= 0
          ) {
            findings.push({
              code: "invalidHardLimitMeasurement",
              detail: `${subject} has an invalid limit or target-use value`,
              subject,
              verdict: "FAIL",
            });
          } else if (maximumObserved > limit.maximum * 0.7) {
            findings.push({
              code: "platformHeadroomInsufficient",
              detail: `${subject} reached ${maximumObserved} ${measurement.unit}, above the 70% maximum`,
              subject,
              verdict: "FAIL",
            });
          }
        }
      }
    }
  }
  return assessmentFromFindings(findings);
};
