import { Effect, Schema, type Crypto } from "effect";

import type { ProviderMessageId } from "../../domain";
import {
  type InboundRoute,
  type InboundWhatsAppMessage,
  WhatsAppAdmissionIdentityDigest,
  WhatsAppIdentityUnavailable,
  WhatsAppProviderContentDigest,
  type WhatsAppStableIdentity,
} from "../../services/whatsapp-admission";

const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

/** Implement stable WhatsApp identity derivation with the Worker Web Crypto service. */
export const make = (crypto: Crypto.Crypto): WhatsAppStableIdentity => ({
  deriveAdmission: (route, providerMessageId) =>
    digest(crypto, encodeAdmissionIdentity(route, providerMessageId)).pipe(
      Effect.map((value) => WhatsAppAdmissionIdentityDigest.make(value)),
    ),
  deriveContent: (message) =>
    digest(crypto, encodeContentIdentity(message)).pipe(
      Effect.map((value) => WhatsAppProviderContentDigest.make(value)),
    ),
});

const encodeAdmissionIdentity = (
  route: Extract<InboundRoute, { readonly _tag: "Bound" }>,
  providerMessageId: ProviderMessageId,
) => encodeIdentity([route.channelBindingId, providerMessageId]);

const encodeContentIdentity = (message: InboundWhatsAppMessage) =>
  encodeIdentity([
    message._tag,
    message.channelIdentity,
    message.phoneNumberId,
    message.providerMessageId,
    message.message,
  ]);

const digest = (crypto: Crypto.Crypto, value: string) =>
  crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
    Effect.map((bytes) =>
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 40),
    ),
    Effect.mapError(
      (cause) =>
        new WhatsAppIdentityUnavailable({
          cause,
          message: "Stable WhatsApp admission identities could not be derived",
        }),
    ),
  );
