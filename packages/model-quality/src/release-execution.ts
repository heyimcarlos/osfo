import { freezeCaseFixture, type CaseFixture } from "./case-fixture";
import { verifyCorpusManifest, type CorpusCase, type CorpusManifest } from "./corpus";
import { digestValue, type EvidenceDigest } from "./manifest";

/** Complete release case after an authorized vault resolves sealed fixture content. */
export type ReleaseExecutionCase = Omit<CorpusCase, "fixture"> & {
  readonly fixture: CaseFixture;
};

/** Failure returned when sealed content is unavailable or fails its manifest digest. */
export type SealedFixtureFailure = {
  readonly error: { readonly _tag: "SealedFixtureUnavailable"; readonly message: string };
  readonly kind: "error";
  readonly verdict: "MISSING";
};

/** Access-controlled fixture capability supplied only to complete release runs. */
export type SealedFixtureVault = {
  readonly resolve: (
    reference: string,
    contentDigest: EvidenceDigest<"fixture">,
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
  if (!verifyCorpusManifest(manifest)) {
    return {
      error: {
        _tag: "SealedFixtureUnavailable",
        message: "The corpus manifest content digest does not match.",
      },
      kind: "error",
      verdict: "MISSING",
    };
  }
  const resolved: Array<ReleaseExecutionCase> = [];
  for (const item of manifest.cases) {
    if (item.split === "development") {
      resolved.push(Object.freeze({ ...item, fixture: item.fixture }));
      continue;
    }
    const fixture = vault.resolve(item.fixture.reference, item.fixture.contentDigest);
    if (fixture.kind === "error") return fixture;
    const frozenFixture = freezeCaseFixture(fixture.value);
    if (
      frozenFixture.fixtureSource !== "sealed-vault-v1" ||
      digestValue("fixture", frozenFixture) !== item.fixture.contentDigest
    ) {
      return {
        error: {
          _tag: "SealedFixtureUnavailable",
          message: `Vault fixture digest for ${item.id} does not match the manifest.`,
        },
        kind: "error",
        verdict: "MISSING",
      };
    }
    resolved.push(Object.freeze({ ...item, fixture: frozenFixture }));
  }
  return { kind: "success", value: Object.freeze(resolved) };
};
