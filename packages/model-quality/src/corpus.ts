import { digestValue, type EvidenceDigest } from "./manifest";
import { freezeCaseFixture, makeCaseFixture, type CaseFixture } from "./case-fixture";
import { isSealedCaseId, sealedContentDigest } from "./sealed-content-digests";

export type { CaseFixture } from "./case-fixture";

/** Launch journeys represented by the initial product-owned corpus. */
export type Journey =
  | "ordinary"
  | "memory"
  | "file-analysis"
  | "gmail"
  | "research-report"
  | "document-build"
  | "scheduled-email"
  | "safety";

/** Corpus visibility used to keep holdout cases unavailable to tuning. */
export type CorpusSplit = "development" | "sealed-holdout";

/** Plan routes that every applicable initial class covers. */
export type PlanRoute = "free" | "adventurer";

/** Independent critical-risk strata that cannot be averaged together. */
export type CriticalRiskClass =
  | "authority"
  | "privacy"
  | "secrets"
  | "data-freshness"
  | "prompt-injection"
  | "external-effects"
  | "evidence-integrity";

type CorpusCaseBase = {
  readonly authorId: string;
  readonly coveredFailureModeIds: ReadonlyArray<string>;
  readonly finalApproverId: string;
  readonly id: string;
  readonly journey: Journey;
  readonly planRoute: PlanRoute;
  readonly provenance: "authored" | "synthetic";
  readonly repetitions: 3 | 5;
  readonly riskClass: "ordinary" | CriticalRiskClass;
  readonly reviewState: "approved";
};

/** One authored or synthetic, independent evaluation case with sealed holdout content hidden. */
export type CorpusCase = CorpusCaseBase &
  (
    | { readonly fixture: CaseFixture; readonly split: "development" }
    | {
        readonly fixture: {
          readonly contentDigest: EvidenceDigest<"fixture">;
          readonly kind: "sealed-reference";
          readonly reference: string;
        };
        readonly split: "sealed-holdout";
      }
  );

/** Immutable identity and contents of one corpus version. */
export type CorpusManifest = {
  readonly cases: ReadonlyArray<CorpusCase>;
  readonly contentDigest: EvidenceDigest<"corpus">;
  readonly createdAt: string;
  readonly deletionLineage: "permanent-authored-or-synthetic";
  readonly knownFailingCaseIds: ReadonlyArray<string>;
  readonly previousVersion: string | null;
  readonly version: string;
};

const journeySizes: ReadonlyArray<readonly [Journey, number]> = [
  ["ordinary", 100],
  ["memory", 100],
  ["file-analysis", 60],
  ["gmail", 60],
  ["research-report", 40],
  ["document-build", 40],
  ["scheduled-email", 40],
  ["safety", 160],
];

const criticalRiskClasses: ReadonlyArray<CriticalRiskClass> = [
  "authority",
  "privacy",
  "secrets",
  "data-freshness",
  "prompt-injection",
  "external-effects",
  "evidence-integrity",
];

const makeCases = (journey: Journey, size: number): ReadonlyArray<CorpusCase> => {
  const holdoutStart = size - size / 5;
  return Array.from({ length: size }, (_, offset): CorpusCase => {
    const ordinal = offset + 1;
    const id = `${journey}-${ordinal.toString().padStart(3, "0")}`;
    const planRoute = ordinal % 2 === 0 ? "adventurer" : "free";
    const riskClass =
      journey === "safety"
        ? (criticalRiskClasses[offset % criticalRiskClasses.length] ?? "authority")
        : "ordinary";
    const common = {
      authorId: `corpus-author-${ordinal % 4}`,
      coveredFailureModeIds: Object.freeze([id]),
      finalApproverId: `corpus-approver-${ordinal % 3}`,
      id,
      journey,
      planRoute,
      provenance: ordinal % 2 === 0 ? "synthetic" : "authored",
      repetitions: journey === "safety" ? 5 : 3,
      riskClass,
      reviewState: "approved",
    } as const;
    return offset >= holdoutStart && isSealedCaseId(id)
      ? Object.freeze({
          ...common,
          fixture: Object.freeze({
            contentDigest: sealedContentDigest(id),
            kind: "sealed-reference" as const,
            reference: `holdout://${id}`,
          }),
          split: "sealed-holdout" as const,
        })
      : Object.freeze({
          ...common,
          fixture: makeCaseFixture(id, journey, planRoute, riskClass, offset),
          split: "development" as const,
        });
  });
};

const cases = Object.freeze(journeySizes.flatMap(([journey, size]) => makeCases(journey, size)));

const initialCorpusContents = Object.freeze({
  cases,
  createdAt: "2026-08-17T00:00:00.000Z",
  deletionLineage: "permanent-authored-or-synthetic",
  knownFailingCaseIds: Object.freeze([]),
  previousVersion: null,
  version: "model-quality-v1",
});

/** The immutable initial 600-case Osfo Model Quality corpus manifest. */
export const initialCorpusManifest: CorpusManifest = Object.freeze({
  ...initialCorpusContents,
  contentDigest: digestValue("corpus", initialCorpusContents),
});

/** Verify that a corpus manifest still matches every immutable content field. */
export const verifyCorpusManifest = (manifest: CorpusManifest): boolean => {
  const { contentDigest, ...contents } = manifest;
  return contentDigest === digestValue("corpus", contents);
};

/** Safety-case authorship approval used for immutable corpus governance. */
export type CorpusSafetyApproval = {
  readonly authorId: string;
  readonly caseId: string;
  readonly finalApproverId: string;
};

/** Inputs for a successor corpus version. */
export type CreateCorpusVersionInput = {
  readonly cases: ReadonlyArray<CorpusCase>;
  readonly createdAt: string;
  readonly newlyFailingCaseIds: ReadonlyArray<string>;
  readonly previous: CorpusManifest;
  readonly safetyApprovals: ReadonlyArray<CorpusSafetyApproval>;
  readonly version: string;
};

/** Expected corpus-governance failure. */
export type InvalidCorpusChange = {
  readonly _tag: "InvalidCorpusChange";
  readonly message: string;
};

/** Result of creating an immutable successor corpus version. */
export type CreateCorpusVersionResult =
  | { readonly kind: "success"; readonly value: CorpusManifest }
  | { readonly error: InvalidCorpusChange; readonly kind: "error" };

/** Create a linked immutable corpus version without deleting known regression evidence. */
export const createCorpusVersion = (input: CreateCorpusVersionInput): CreateCorpusVersionResult => {
  const nextIds = new Set(input.cases.map((item) => item.id));
  const knownFailingCaseIds = Object.freeze([
    ...new Set([...input.previous.knownFailingCaseIds, ...input.newlyFailingCaseIds]),
  ]);
  for (const caseId of knownFailingCaseIds) {
    if (!nextIds.has(caseId))
      return invalidCorpusChange(`Known failing case ${caseId} cannot be removed.`);
  }
  const unsafeApproval = input.safetyApprovals.find(
    (approval) => approval.authorId === approval.finalApproverId,
  );
  if (unsafeApproval !== undefined) {
    return invalidCorpusChange(
      `Safety case ${unsafeApproval.caseId} requires an independent final approver.`,
    );
  }
  const previousCases = new Map(input.previous.cases.map((item) => [item.id, item]));
  for (const item of input.cases) {
    if (item.journey === "safety" && item.authorId === item.finalApproverId) {
      return invalidCorpusChange(`Safety case ${item.id} requires an independent final approver.`);
    }
    const previous = previousCases.get(item.id);
    const changedSafetyCase =
      item.journey === "safety" &&
      (previous === undefined || digestValue("fixture", item) !== digestValue("fixture", previous));
    const approval = input.safetyApprovals.find(
      (candidate) =>
        candidate.caseId === item.id &&
        candidate.authorId === item.authorId &&
        candidate.finalApproverId === item.finalApproverId,
    );
    if (changedSafetyCase && approval === undefined) {
      return invalidCorpusChange(`Safety case ${item.id} requires recorded independent approval.`);
    }
  }
  if (input.version === input.previous.version) {
    return invalidCorpusChange("A corpus successor requires a new version.");
  }
  const contents = Object.freeze({
    cases: Object.freeze(input.cases.map(freezeCorpusCase)),
    createdAt: input.createdAt,
    deletionLineage: "permanent-authored-or-synthetic" as const,
    knownFailingCaseIds,
    previousVersion: input.previous.version,
    version: input.version,
  });
  return {
    kind: "success",
    value: Object.freeze({ ...contents, contentDigest: digestValue("corpus", contents) }),
  };
};

const freezeCorpusCase = (item: CorpusCase): CorpusCase =>
  item.split === "sealed-holdout"
    ? Object.freeze({
        ...item,
        coveredFailureModeIds: Object.freeze([...item.coveredFailureModeIds]),
        fixture: Object.freeze({ ...item.fixture }),
      })
    : Object.freeze({
        ...item,
        coveredFailureModeIds: Object.freeze([...item.coveredFailureModeIds]),
        fixture: freezeCaseFixture(item.fixture),
      });

const invalidCorpusChange = (message: string): CreateCorpusVersionResult => ({
  error: { _tag: "InvalidCorpusChange", message },
  kind: "error",
});
