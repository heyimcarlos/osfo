import { Option, Schema } from "effect";

import {
  ArtifactChecksum,
  EvidenceCount,
  QualificationId,
  QualificationUtcInstant,
} from "./evidence-primitives";
import { qualificationChecksum } from "./qualification-checksum";
import type { QualificationFinding } from "./verdict";

/** Immutable retained artifact for one exact qualification corpus. */
export interface EvidenceArtifact<RecordValue = string> {
  readonly artifactId: string;
  readonly checksum: string;
  readonly count: number;
  readonly records: ReadonlyArray<RecordValue>;
  readonly windowEndedAtUtc: string;
  readonly windowStartedAtUtc: string;
}

const artifactBoundary = <A>(record: Schema.Codec<A, unknown>) =>
  Schema.Struct({
    artifactId: QualificationId,
    checksum: ArtifactChecksum,
    count: EvidenceCount,
    records: Schema.Array(record),
    windowEndedAtUtc: QualificationUtcInstant,
    windowStartedAtUtc: QualificationUtcInstant,
  });

const finding = (
  code: string,
  detail: string,
  subject: string,
  verdict: QualificationFinding["verdict"],
): QualificationFinding => ({ code, detail, subject, verdict });

/** Parse and checksum one retained artifact at the qualification I/O boundary. */
export const parseEvidenceArtifact = <A>(
  // oxlint-disable-next-line osfo/no-unknown-parameters -- This is the shared artifact I/O boundary.
  artifact: unknown,
  recordBoundary: Schema.Codec<A, unknown>,
  subject: string,
  findings: Array<QualificationFinding>,
): EvidenceArtifact<A> | undefined => {
  const parsed = Option.getOrUndefined(
    Schema.decodeUnknownOption(artifactBoundary(recordBoundary))(artifact),
  );
  if (parsed === undefined || parsed.count !== parsed.records.length) {
    findings.push(
      finding(
        "arrivalArtifactInvalid",
        `${subject} has no complete retained artifact`,
        subject,
        "MISSING",
      ),
    );
    return parsed;
  }
  if (Date.parse(parsed.windowEndedAtUtc) <= Date.parse(parsed.windowStartedAtUtc)) {
    findings.push(
      finding("arrivalWindowInvalid", `${subject} has a non-positive UTC window`, subject, "FAIL"),
    );
  } else if (parsed.checksum !== qualificationChecksum(parsed.records)) {
    findings.push(
      finding(
        "artifactChecksumMismatch",
        `${subject} content does not match its checksum`,
        subject,
        "FAIL",
      ),
    );
  }
  return parsed;
};
