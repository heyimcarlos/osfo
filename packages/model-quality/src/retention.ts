/** Retention class for evaluation records. */
export type EvaluationRecordClass =
  | "temporary-content"
  | "content-free-metadata"
  | "flagged-review-bundle"
  | "consented-real-trace";

/** Parsed retention-expiry result. */
export type EvaluationExpiryResult =
  | { readonly kind: "success"; readonly value: number }
  | { readonly error: { readonly _tag: "InvalidRetentionInstant" }; readonly kind: "error" };

/** Calculate the maximum retained-until epoch millisecond for an evaluation record. */
export const evaluationExpiry = (
  recordClass: EvaluationRecordClass,
  createdAtEpochMs: number,
): EvaluationExpiryResult => {
  if (!Number.isFinite(createdAtEpochMs) || createdAtEpochMs < 0) {
    return { error: { _tag: "InvalidRetentionInstant" }, kind: "error" };
  }
  const hours =
    recordClass === "temporary-content"
      ? 24
      : recordClass === "consented-real-trace"
        ? 24 * 90
        : 24 * 30;
  return { kind: "success", value: createdAtEpochMs + hours * 60 * 60 * 1_000 };
};

/** Basis under which private content was selected for human review. */
export type PrivateReviewRequest = {
  readonly basis:
    | "user-feedback-consent"
    | "documented-security-need"
    | "documented-support-need"
    | "random-sample";
};

/** Decision on whether a human may read selected private content. */
export type PrivateReviewDecision = { readonly verdict: "ALLOWED" | "PROHIBITED" };

/** Decide whether private content may be read by a human. */
export const reviewPrivateContent = (request: PrivateReviewRequest): PrivateReviewDecision => ({
  verdict: request.basis === "random-sample" ? "PROHIBITED" : "ALLOWED",
});
