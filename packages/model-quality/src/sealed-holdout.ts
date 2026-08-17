import { makeCaseFixture, type CaseFixture } from "./case-fixture";
import type { CorpusCase } from "./corpus";
import { digestValue } from "./manifest";

export type SealedFixtureResolution =
  | { readonly kind: "success"; readonly value: CaseFixture }
  | {
      readonly error: { readonly _tag: "InvalidSealedFixture"; readonly message: string };
      readonly kind: "error";
    };

export const resolveSealedFixture = (
  item: Extract<CorpusCase, { readonly split: "sealed-holdout" }>,
): SealedFixtureResolution => {
  const expectedReference = `holdout://${item.id}`;
  const ordinalText = item.id.slice(item.id.lastIndexOf("-") + 1);
  const ordinal = Number(ordinalText);
  if (item.fixture.reference !== expectedReference || !Number.isInteger(ordinal) || ordinal <= 0) {
    return invalidSealedFixture(`Sealed reference for ${item.id} is invalid.`);
  }
  const fixture = makeCaseFixture(item.id, item.journey, ordinal - 1);
  if (digestValue("fixture", fixture) !== item.fixture.contentDigest) {
    return invalidSealedFixture(`Sealed fixture digest for ${item.id} does not match.`);
  }
  return { kind: "success", value: fixture };
};

const invalidSealedFixture = (message: string): SealedFixtureResolution => ({
  error: { _tag: "InvalidSealedFixture", message },
  kind: "error",
});
