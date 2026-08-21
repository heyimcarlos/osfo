import { ChannelLinkInviteToken } from "@osfo/api";
import { type Crypto, Encoding, Effect, Redacted } from "effect";

import { ChannelLinksUnavailable } from "./model";

/**
 * Alphanumeric-only alphabet: no separators to lose inside underlined chat links.
 * Eight characters carry about 47.6 bits of entropy, far beyond online guessing
 * against short-lived invitations.
 */
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_LENGTH = 8;
/** Six-bit draws past the alphabet are rejected, so over-draw to finish in one pass. */
const DRAW_BYTES = 16;

/** Draw one cryptographically random invitation token from runtime secure randomness. */
export const generateInviteToken = (crypto: Crypto.Crypto) =>
  Effect.gen(function* () {
    const characters: Array<string> = [];
    while (characters.length < TOKEN_LENGTH) {
      const bytes = yield* crypto
        .randomBytes(DRAW_BYTES)
        .pipe(
          Effect.mapError(
            (cause) => new ChannelLinksUnavailable({ cause, operation: "generateInviteToken" }),
          ),
        );
      for (const byte of bytes) {
        if (characters.length === TOKEN_LENGTH) break;
        const character = TOKEN_ALPHABET[byte & 0x3f];
        if (character !== undefined) characters.push(character);
      }
    }
    return ChannelLinkInviteToken.make(characters.join(""));
  });

/** Reduce an invitation token to its stored lookup form without retaining bearer material. */
export const hashInviteToken = (
  crypto: Crypto.Crypto,
  token: Redacted.Redacted<typeof ChannelLinkInviteToken.Type>,
) =>
  crypto.digest("SHA-256", new TextEncoder().encode(Redacted.value(token))).pipe(
    Effect.map(Encoding.encodeHex),
    Effect.mapError(
      (cause) => new ChannelLinksUnavailable({ cause, operation: "hashInviteToken" }),
    ),
  );
