import { digestValue, parseEvidenceDigest, type EvidenceDigest } from "./manifest";
import { freezeCaseFixture, makeDevelopmentFixture, type CaseFixture } from "./case-fixture";
import { isSealedCaseId, sealedContentDigest } from "./sealed-content-digests";
import {
  parseApprovalId,
  parseCaseId,
  parseEvidenceInstant,
  parseVersionId,
  type ApprovalId,
  type CaseId,
  type EvidenceInstant,
  type IdentityResult,
  type VersionId,
} from "./identity";

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
  readonly authorId: ApprovalId;
  readonly coveredFailureModeIds: ReadonlyArray<string>;
  readonly finalApproverId: ApprovalId;
  readonly id: CaseId;
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
  readonly createdAt: EvidenceInstant;
  readonly deletionLineage: "permanent-authored-or-synthetic";
  readonly knownFailingCaseIds: ReadonlyArray<CaseId>;
  readonly previousContentDigest: EvidenceDigest<"corpus"> | null;
  readonly previousVersion: VersionId | null;
  readonly version: VersionId;
};

/** Ordered trusted corpus manifests from the product root to the direct predecessor. */
export type CorpusLineage = ReadonlyArray<CorpusManifest>;

const parsedIdentity = <T>(result: IdentityResult<T>): T => {
  if (result.kind === "error") throw new Error(`Invalid static ${result.error.identity} identity.`);
  return result.value;
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

const parsedInitialCorpusDigest = parseEvidenceDigest(
  "corpus",
  "sha256:f941329b1fd33beb58e77607dc7ab15f0b92d1c94ff12f1a09a57ff00548c761",
);
if (parsedInitialCorpusDigest.kind === "error")
  throw new Error("Initial corpus digest is invalid.");
const trustedInitialCorpusDigest = parsedInitialCorpusDigest.value;

const makeCases = (journey: Journey, size: number): ReadonlyArray<CorpusCase> => {
  const holdoutStart = size - size / 5;
  return Array.from({ length: size }, (_, offset): CorpusCase => {
    const ordinal = offset + 1;
    const id = parsedIdentity(parseCaseId(`${journey}-${ordinal.toString().padStart(3, "0")}`));
    const planRoute = ordinal % 2 === 0 ? "adventurer" : "free";
    const riskClass =
      journey === "safety"
        ? (criticalRiskClasses[offset % criticalRiskClasses.length] ?? "authority")
        : "ordinary";
    const common = {
      authorId: parsedIdentity(parseApprovalId(`corpus-author-${ordinal % 4}`)),
      coveredFailureModeIds: Object.freeze([id]),
      finalApproverId: parsedIdentity(parseApprovalId(`corpus-approver-${ordinal % 3}`)),
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
          fixture: makeDevelopmentFixture(id, journey, planRoute, riskClass, offset),
          split: "development" as const,
        });
  });
};

const cases = Object.freeze(journeySizes.flatMap(([journey, size]) => makeCases(journey, size)));

const initialCorpusContents = Object.freeze({
  cases,
  createdAt: parsedIdentity(parseEvidenceInstant("2026-08-17T00:00:00.000Z")),
  deletionLineage: "permanent-authored-or-synthetic",
  knownFailingCaseIds: Object.freeze([]),
  previousContentDigest: null,
  previousVersion: null,
  version: parsedIdentity(parseVersionId("model-quality-v1")),
});

/** The immutable initial 600-case Osfo Model Quality corpus manifest. */
export const initialCorpusManifest: CorpusManifest = Object.freeze({
  ...initialCorpusContents,
  contentDigest: digestValue("corpus", initialCorpusContents),
});

/** Less-trusted persisted corpus shape accepted at the parsing boundary. */
type PersistedCorpusCase = Omit<CorpusCaseBase, "authorId" | "finalApproverId" | "id"> & {
  readonly authorId: string;
  readonly finalApproverId: string;
  readonly fixture:
    | CaseFixture
    | {
        readonly contentDigest: EvidenceDigest<"fixture">;
        readonly kind: "sealed-reference";
        readonly reference: string;
      };
  readonly id: string;
  readonly split: CorpusSplit;
};

export type PersistedCorpusManifest = {
  readonly contentDigest: EvidenceDigest<"corpus">;
  readonly createdAt: string;
  readonly deletionLineage: "permanent-authored-or-synthetic";
  readonly knownFailingCaseIds: ReadonlyArray<string>;
  readonly previousContentDigest: EvidenceDigest<"corpus"> | null;
  readonly previousVersion: string | null;
  readonly version: string;
  readonly cases: ReadonlyArray<PersistedCorpusCase>;
};

/** Expected failure returned for an invalid persisted corpus manifest. */
export type InvalidCorpusManifest = {
  readonly _tag: "InvalidCorpusManifest";
  readonly message: string;
};

/** Parsed corpus-manifest result. */
export type ParseCorpusManifestResult =
  | { readonly kind: "success"; readonly value: CorpusManifest }
  | { readonly error: InvalidCorpusManifest; readonly kind: "error" };

/** Parse one immutable corpus version and its direct predecessor linkage. */
export const parseCorpusManifest = (
  persisted: PersistedCorpusManifest,
  lineage: CorpusLineage,
): ParseCorpusManifestResult => {
  const predecessor = verifyCorpusLineage(lineage);
  if (predecessor.kind === "error") return predecessor;
  const message = corpusInvariantFailure(persisted, predecessor.value);
  if (message !== null) {
    return { error: { _tag: "InvalidCorpusManifest", message }, kind: "error" };
  }
  return { kind: "success", value: freezeCorpusManifest(persisted) };
};

/** Verify one corpus manifest with the same parser used at creation. */
export const verifyCorpusManifest = (
  manifest: CorpusManifest,
  lineage: CorpusLineage = [],
): boolean => parseCorpusManifest(manifest, lineage).kind === "success";

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
  readonly previousLineage: CorpusLineage;
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
  if (!verifyCorpusManifest(input.previous, input.previousLineage)) {
    return invalidCorpusChange("The predecessor corpus manifest is invalid.");
  }
  const parsedNewlyFailingCaseIds = input.newlyFailingCaseIds.map(parseCaseId);
  if (parsedNewlyFailingCaseIds.some((result) => result.kind === "error")) {
    return invalidCorpusChange("New failing case identities are invalid.");
  }
  const nextIds = new Set(input.cases.map((item) => item.id));
  const knownFailingCaseIds = Object.freeze([
    ...new Set([
      ...input.previous.knownFailingCaseIds,
      ...parsedNewlyFailingCaseIds.flatMap((result) =>
        result.kind === "success" ? [result.value] : [],
      ),
    ]),
  ]);
  for (const caseId of knownFailingCaseIds) {
    if (!nextIds.has(caseId))
      return invalidCorpusChange(`Known failing case ${caseId} cannot be removed.`);
  }
  const unsafeApproval = input.safetyApprovals.find(
    (approval) =>
      parseApprovalId(approval.authorId).kind === "error" ||
      parseApprovalId(approval.finalApproverId).kind === "error" ||
      parseCaseId(approval.caseId).kind === "error" ||
      approval.authorId === approval.finalApproverId,
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
    previousContentDigest: input.previous.contentDigest,
    previousVersion: input.previous.version,
    version: input.version,
  });
  const candidate = Object.freeze({ ...contents, contentDigest: digestValue("corpus", contents) });
  const parsed = parseCorpusManifest(candidate, [...input.previousLineage, input.previous]);
  return parsed.kind === "error"
    ? invalidCorpusChange(parsed.error.message)
    : { kind: "success", value: parsed.value };
};

const corpusInvariantFailure = (
  manifest: PersistedCorpusManifest,
  predecessor: CorpusManifest | null,
): string | null => {
  const { contentDigest, ...contents } = manifest;
  if (contentDigest !== digestValue("corpus", contents)) return "Corpus content digest mismatch.";
  if (parseEvidenceInstant(manifest.createdAt).kind === "error")
    return "Corpus creation time is invalid.";
  if (parseVersionId(manifest.version).kind === "error") return "Corpus version is invalid.";
  if (
    manifest.previousVersion !== null &&
    parseVersionId(manifest.previousVersion).kind === "error"
  )
    return "Corpus predecessor version is invalid.";
  const caseIds = manifest.cases.map((item) => item.id);
  if (
    caseIds.some((id) => parseCaseId(id).kind === "error") ||
    new Set(caseIds).size !== caseIds.length
  ) {
    return "Corpus case identities must be non-empty and unique.";
  }
  for (const item of manifest.cases) {
    const commonInvalid =
      parseApprovalId(item.authorId).kind === "error" ||
      parseApprovalId(item.finalApproverId).kind === "error" ||
      item.reviewState !== "approved" ||
      item.coveredFailureModeIds.length === 0 ||
      new Set(item.coveredFailureModeIds).size !== item.coveredFailureModeIds.length;
    if (commonInvalid) return `Corpus case ${item.id} has invalid approval metadata.`;
    if (
      (item.journey === "safety" &&
        (item.repetitions !== 5 ||
          item.riskClass === "ordinary" ||
          item.authorId === item.finalApproverId)) ||
      (item.journey !== "safety" && (item.repetitions !== 3 || item.riskClass !== "ordinary"))
    ) {
      return `Corpus case ${item.id} has invalid journey or repetition metadata.`;
    }
    if (
      (item.split === "development" &&
        !(
          "fixtureSource" in item.fixture && item.fixture.fixtureSource === "development-corpus-v1"
        )) ||
      (item.split === "sealed-holdout" &&
        !(
          "kind" in item.fixture &&
          item.fixture.kind === "sealed-reference" &&
          item.fixture.reference === `holdout://${item.id}` &&
          isSealedCaseId(item.id) &&
          item.fixture.contentDigest === sealedContentDigest(item.id)
        ))
    ) {
      return `Corpus case ${item.id} has an invalid fixture source for its split.`;
    }
  }
  if (!hasRequiredInitialComposition(manifest.cases)) {
    return "Corpus versions require the exact 600-case composition and 20% sealed ratio per class.";
  }
  if (
    new Set(manifest.knownFailingCaseIds).size !== manifest.knownFailingCaseIds.length ||
    manifest.knownFailingCaseIds.some((id) => !caseIds.includes(id))
  ) {
    return "Known failing case identities must be unique members of the corpus.";
  }
  if (predecessor === null) {
    return manifest.previousVersion === null &&
      manifest.previousContentDigest === null &&
      manifest.version === initialCorpusManifest.version &&
      manifest.contentDigest === trustedInitialCorpusDigest
      ? null
      : "The initial corpus must match the product-owned root manifest.";
  }
  if (
    manifest.previousVersion !== predecessor.version ||
    manifest.previousContentDigest !== predecessor.contentDigest ||
    manifest.version === predecessor.version ||
    Date.parse(manifest.createdAt) <= Date.parse(predecessor.createdAt)
  ) {
    return "Corpus predecessor identity, version, or timestamp is invalid.";
  }
  return null;
};

/** Check the frozen initial case counts and sealed ratio for every journey class. */
const hasRequiredInitialComposition = (corpusCases: ReadonlyArray<PersistedCorpusCase>): boolean =>
  corpusCases.length === 600 &&
  journeySizes.every(([journey, required]) => {
    const casesForJourney = corpusCases.filter((item) => item.journey === journey);
    return (
      casesForJourney.length === required &&
      casesForJourney.filter((item) => item.split === "sealed-holdout").length === required / 5
    );
  });

const verifyCorpusLineage = (
  lineage: CorpusLineage,
):
  | { readonly kind: "success"; readonly value: CorpusManifest | null }
  | { readonly error: InvalidCorpusManifest; readonly kind: "error" } => {
  let predecessor: CorpusManifest | null = null;
  for (const manifest of lineage) {
    const message = corpusInvariantFailure(manifest, predecessor);
    if (message !== null) {
      return { error: { _tag: "InvalidCorpusManifest", message }, kind: "error" };
    }
    predecessor = manifest;
  }
  return { kind: "success", value: predecessor };
};

const freezeCorpusManifest = (manifest: PersistedCorpusManifest): CorpusManifest =>
  Object.freeze({
    ...manifest,
    createdAt: parsedIdentity(parseEvidenceInstant(manifest.createdAt)),
    cases: Object.freeze(
      manifest.cases.map((item) => {
        // SAFETY: corpusInvariantFailure parsed the split and matching fixture variant before this normalization.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The persisted union is intentionally wider at the parsing boundary.
        return freezeCorpusCase({
          ...item,
          authorId: parsedIdentity(parseApprovalId(item.authorId)),
          finalApproverId: parsedIdentity(parseApprovalId(item.finalApproverId)),
          id: parsedIdentity(parseCaseId(item.id)),
        } as CorpusCase);
      }),
    ),
    knownFailingCaseIds: Object.freeze(
      manifest.knownFailingCaseIds.map((id) => parsedIdentity(parseCaseId(id))),
    ),
    previousVersion:
      manifest.previousVersion === null
        ? null
        : parsedIdentity(parseVersionId(manifest.previousVersion)),
    version: parsedIdentity(parseVersionId(manifest.version)),
  });

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
