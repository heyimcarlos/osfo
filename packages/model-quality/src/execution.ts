import type { CorpusCase, CorpusManifest, Journey } from "./corpus";

/** One case scheduled at an execution level. */
export type ExecutionCase = Omit<CorpusCase, "repetitions"> & { readonly repetitions: 1 | 3 | 5 };

/** Pull-request or complete-gate execution request. */
export type ExecutionRequest =
  | {
      readonly affectedDeterministicChecks: ReadonlyArray<string>;
      readonly level: "pull-request";
      readonly mappedCriticalCaseIds: ReadonlyArray<string>;
    }
  | { readonly level: "complete" };

/** Frozen case selection and evidence status for one gate level. */
export type ExecutionPlan = {
  readonly affectedDeterministicChecks: ReadonlyArray<string>;
  readonly cases: ReadonlyArray<ExecutionCase>;
  readonly finalEvidence: boolean;
  readonly level: ExecutionRequest["level"];
};

const smokeJourneys: ReadonlyArray<Exclude<Journey, "safety">> = [
  "ordinary",
  "memory",
  "file-analysis",
  "gmail",
  "research-report",
  "document-build",
  "scheduled-email",
];

/** Select the reproducible PR smoke set or the complete repeated corpus. */
export const createExecutionPlan = (
  manifest: CorpusManifest,
  request: ExecutionRequest,
): ExecutionPlan => {
  if (request.level === "complete") {
    return Object.freeze({
      affectedDeterministicChecks: Object.freeze([]),
      cases: Object.freeze([...manifest.cases]),
      finalEvidence: true,
      level: request.level,
    });
  }

  const developmentCases = manifest.cases.filter((item) => item.split === "development");
  const smoke = smokeJourneys.flatMap((journey) =>
    developmentCases.filter((item) => item.journey === journey).slice(0, 5),
  );
  const safetySmoke = developmentCases.filter((item) => item.journey === "safety").slice(0, 20);
  const mappedCritical = developmentCases.filter(
    (item) => item.riskClass !== "ordinary" && request.mappedCriticalCaseIds.includes(item.id),
  );
  const selected = uniqueCases([...smoke, ...safetySmoke, ...mappedCritical]).map(
    (item): ExecutionCase => Object.freeze({ ...item, repetitions: 1 }),
  );
  return Object.freeze({
    affectedDeterministicChecks: Object.freeze([...request.affectedDeterministicChecks]),
    cases: Object.freeze(selected),
    finalEvidence: false,
    level: request.level,
  });
};

const uniqueCases = (cases: ReadonlyArray<CorpusCase>) => {
  const byId = new Map(cases.map((item) => [item.id, item]));
  return [...byId.values()];
};
