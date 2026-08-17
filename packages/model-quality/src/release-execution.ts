import type { CaseFixture } from "./case-fixture";
import type { CorpusCase, CorpusManifest } from "./corpus";
import { resolveSealedFixture, type SealedFixtureResolution } from "./sealed-holdout";

export type ReleaseExecutionCase = Omit<CorpusCase, "fixture"> & {
  readonly fixture: CaseFixture;
};

export type ReleaseExecutionResult =
  | { readonly kind: "success"; readonly value: ReadonlyArray<ReleaseExecutionCase> }
  | Exclude<SealedFixtureResolution, { readonly kind: "success" }>;

export const resolveCompleteReleaseCorpus = (manifest: CorpusManifest): ReleaseExecutionResult => {
  const resolved: Array<ReleaseExecutionCase> = [];
  for (const item of manifest.cases) {
    if (item.split === "development") {
      resolved.push(Object.freeze({ ...item, fixture: item.fixture }));
      continue;
    }
    const fixture = resolveSealedFixture(item);
    if (fixture.kind === "error") return fixture;
    resolved.push(Object.freeze({ ...item, fixture: fixture.value }));
  }
  return { kind: "success", value: Object.freeze(resolved) };
};
