import { Data, Effect, Encoding, Redacted } from "effect";

export class QualificationEnrollmentDigestUnavailable extends Data.TaggedError(
  "QualificationEnrollmentDigestUnavailable",
)<{ readonly cause: unknown; readonly message: string }> {}

/** Keyed, content-free identity used to bind one verified phone to a pre-signup provision. */
export const qualificationEnrollmentDigest = (
  secret: Redacted.Redacted,
  verifiedPhoneNumber: string,
) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- Web Crypto exposes a Promise-native host boundary.
    try: async () => {
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(Redacted.value(secret)),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
      );
      const signature = await globalThis.crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(verifiedPhoneNumber),
      );
      return Encoding.encodeBase64Url(new Uint8Array(signature));
    },
    catch: (cause) =>
      new QualificationEnrollmentDigestUnavailable({
        cause,
        message: "Qualification enrollment digest is unavailable",
      }),
  });
