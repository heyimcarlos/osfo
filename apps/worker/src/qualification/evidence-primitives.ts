import { DateTime, Option, Schema } from "effect";

/** Non-empty qualification identity parsed at an evidence boundary. */
export const QualificationId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("QualificationId"),
);

/** Non-empty qualification identity parsed at an evidence boundary. */
export type QualificationId = typeof QualificationId.Type;

/** Reproducible artifact checksum parsed at an evidence boundary. */
export const ArtifactChecksum = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (/^[0-9a-z][0-9a-z:_-]+$/iu.test(value) && value.length > 8) ||
      "must be a named non-empty checksum",
  ),
).pipe(Schema.brand("ArtifactChecksum"));

/** Reproducible artifact checksum parsed at an evidence boundary. */
export type ArtifactChecksum = typeof ArtifactChecksum.Type;

/** UTC ISO 8601 instant parsed at an evidence boundary. */
export const QualificationUtcInstant = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (value.endsWith("Z") && Option.isSome(DateTime.make(value))) ||
      "must be a valid UTC ISO 8601 instant",
  ),
).pipe(Schema.brand("QualificationUtcInstant"));

/** UTC ISO 8601 instant parsed at an evidence boundary. */
export type QualificationUtcInstant = typeof QualificationUtcInstant.Type;

/** Non-negative finite integer parsed at an evidence boundary. */
export const EvidenceCount = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("EvidenceCount"));

/** Non-negative finite integer parsed at an evidence boundary. */
export type EvidenceCount = typeof EvidenceCount.Type;

/** Non-negative finite measurement parsed at an evidence boundary. */
export const NonNegativeMeasurement = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("NonNegativeMeasurement"),
);

/** Non-negative finite measurement parsed at an evidence boundary. */
export type NonNegativeMeasurement = typeof NonNegativeMeasurement.Type;
