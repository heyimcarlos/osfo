import { Data } from "effect";

export class QualificationCohortAuthorityUnavailable extends Data.TaggedError(
  "QualificationCohortAuthorityUnavailable",
)<{
  readonly cause: unknown;
  readonly message: string;
  readonly operation: string;
}> {}
