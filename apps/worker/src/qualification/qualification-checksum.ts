import { Array as EffectArray, Order, Predicate } from "effect";

/** Canonical JSON text for one qualification policy or retained artifact. */
// oxlint-disable-next-line osfo/no-object-parameters -- This internal serializer accepts only already-parsed qualification domain objects.
export const canonicalQualificationJson = (value: object): string =>
  JSON.stringify(value, (_key, nested) => {
    if (Predicate.isBigInt(nested)) return `${nested}n`;
    if (Predicate.isObject(nested)) {
      return Object.fromEntries(
        EffectArray.sortWith(Object.entries(nested), ([key]) => key, Order.String),
      );
    }
    return nested;
  });

/** Reproducible FNV-1a checksum for manifest and artifact integrity checks. */
// oxlint-disable-next-line osfo/no-object-parameters -- Each caller owns and parses its qualification domain object before checksumming it.
export const qualificationChecksum = (value: object): string => {
  let hash = 14_695_981_039_346_656_037n;
  for (const character of canonicalQualificationJson(value)) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
};
