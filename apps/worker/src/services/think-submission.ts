import { Schema } from "effect";

/** Classified failure from a durable Think submission operation. */
export class ThinkSubmissionUnavailable extends Schema.TaggedError<ThinkSubmissionUnavailable>()(
  "ThinkSubmissionUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}
