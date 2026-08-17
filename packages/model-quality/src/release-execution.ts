import type { CaseFixture } from "./case-fixture";
import type { CorpusCase, CorpusManifest } from "./corpus";
import type { EvidenceDigest } from "./manifest";

/** Complete release case after an authorized vault resolves sealed fixture content. */
export type ReleaseExecutionCase = Omit<CorpusCase, "fixture"> & {
  readonly fixture: CaseFixture;
};

/** Failure returned when sealed content is unavailable or fails its manifest digest. */
export type SealedFixtureFailure = {
  readonly error: { readonly _tag: "SealedFixtureUnavailable"; readonly message: string };
  readonly kind: "error";
};

/** Access-controlled fixture capability supplied only to complete release runs. */
export type SealedFixtureVault = {
  readonly resolve: (
    reference: string,
    referenceDigest: EvidenceDigest<"fixture">,
  ) => { readonly kind: "success"; readonly value: CaseFixture } | SealedFixtureFailure;
};

/** Result of resolving the complete corpus through the release-only vault boundary. */
export type ReleaseExecutionResult =
  | { readonly kind: "success"; readonly value: ReadonlyArray<ReleaseExecutionCase> }
  | SealedFixtureFailure;

/** Resolve all holdout references without exposing their content to tuning code. */
export const resolveCompleteReleaseCorpus = (
  manifest: CorpusManifest,
  vault: SealedFixtureVault,
): ReleaseExecutionResult => {
  const resolved: Array<ReleaseExecutionCase> = [];
  for (const item of manifest.cases) {
    if (item.split === "development") {
      resolved.push(Object.freeze({ ...item, fixture: item.fixture }));
      continue;
    }
    const fixture = vault.resolve(item.fixture.reference, item.fixture.referenceDigest);
    if (fixture.kind === "error") return fixture;
    resolved.push(Object.freeze({ ...item, fixture: fixture.value }));
  }
  return { kind: "success", value: Object.freeze(resolved) };
};
