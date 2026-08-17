import type { CorpusCase, CorpusManifest, Journey } from "./corpus";

/** One case scheduled at an execution level. */
type WithExecutionRepetitions<T> = T extends CorpusCase
  ? Omit<T, "repetitions"> & { readonly repetitions: 1 | 3 | 5 }
  : never;

/** One case scheduled at an execution level. */
export type ExecutionCase = WithExecutionRepetitions<CorpusCase>;

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

/** Notices and elapsed time that require a new complete production gate. */
export type CompleteGateRequirementInput = {
  readonly lastCompletedAt: string;
  readonly materialConfigurationChanged: boolean;
  readonly notices: ReadonlyArray<"provider-model" | "route" | "policy" | "material-dependency">;
  readonly now: string;
};

/** Require weekly and notice-driven complete production reruns. */
export const assessCompleteGateRequirement = (
  input: CompleteGateRequirementInput,
): "CURRENT" | "REQUIRED" => {
  const elapsed = Date.parse(input.now) - Date.parse(input.lastCompletedAt);
  return !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    elapsed >= 7 * 24 * 60 * 60 * 1_000 ||
    input.materialConfigurationChanged ||
    input.notices.length > 0
    ? "REQUIRED"
    : "CURRENT";
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
