export type EvidenceVerdict = "PASS" | "FAIL" | "MISSING";

export type GateAttempt =
  | { readonly kind: "initial"; readonly verdict: EvidenceVerdict }
  | { readonly kind: "evidence-retry"; readonly verdict: EvidenceVerdict }
  | {
      readonly kind: "repair-verification";
      readonly verdict: EvidenceVerdict;
      readonly diagnosis: string;
      readonly regressionTest: string;
      readonly fix: string;
    };

const isRecordedRepair = (
  attempt: GateAttempt,
): attempt is Extract<GateAttempt, { readonly kind: "repair-verification" }> =>
  attempt.kind === "repair-verification" &&
  attempt.verdict === "PASS" &&
  attempt.diagnosis.trim().length > 0 &&
  attempt.regressionTest.trim().length > 0 &&
  attempt.fix.trim().length > 0;

export const resolveGateVerdict = (attempts: ReadonlyArray<GateAttempt>): EvidenceVerdict => {
  const initial = attempts[0];
  if (initial?.kind !== "initial") return "MISSING";

  let verdict = initial.verdict;
  for (const attempt of attempts.slice(1)) {
    if (attempt.verdict === "FAIL") {
      verdict = "FAIL";
    } else if (isRecordedRepair(attempt)) {
      verdict = attempt.verdict;
    }
  }
  return verdict;
};
