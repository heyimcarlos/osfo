import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Array, Order, Predicate } from "effect";

/** Canonical JSON text for one qualification policy or retained artifact. */
// oxlint-disable-next-line osfo/no-object-parameters -- This internal serializer accepts only already-parsed qualification domain objects.
export const canonicalQualificationJson = (value: object): string =>
  JSON.stringify(value, (_key, nested) => {
    if (Predicate.isBigInt(nested)) return `${nested}n`;
    if (Predicate.isObject(nested)) {
      return Object.fromEntries(
        Array.sortWith(Object.entries(nested), ([key]) => key, Order.String),
      );
    }
    return nested;
  });

/** Reproducible, domain-separated SHA-256 digest for manifest and artifact integrity checks. */
// oxlint-disable-next-line osfo/no-object-parameters -- Each caller owns and parses its qualification domain object before checksumming it.
export const qualificationChecksum = (value: object): string =>
  `sha256:${bytesToHex(
    sha256(
      new TextEncoder().encode(
        `osfo-production-qualification-v1:${canonicalQualificationJson(value)}`,
      ),
    ),
  )}`;
