/** One fail-closed production qualification outcome, ordered by severity. */
export type QualificationVerdict = "FAIL" | "MISSING" | "PASS";

/** One reproducible reason for a qualification verdict. */
export interface QualificationFinding {
  readonly code: string;
  readonly detail: string;
  readonly subject: string;
  readonly verdict: Exclude<QualificationVerdict, "PASS">;
}

/** A fail-closed verdict with its ordered material findings. */
export interface QualificationAssessment {
  readonly findings: ReadonlyArray<QualificationFinding>;
  readonly verdict: QualificationVerdict;
}

/** Combine findings with FAIL before MISSING and PASS only for complete evidence. */
export const assessmentFromFindings = (
  findings: ReadonlyArray<QualificationFinding>,
): QualificationAssessment => ({
  findings,
  verdict: findings.some((finding) => finding.verdict === "FAIL")
    ? "FAIL"
    : findings.some((finding) => finding.verdict === "MISSING")
      ? "MISSING"
      : "PASS",
});
