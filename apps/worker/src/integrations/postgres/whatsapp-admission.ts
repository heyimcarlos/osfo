import { DateTime, Effect, Schema } from "effect";

import { database } from "../../db";
import type { RouteInput } from "../../services/whatsapp-admission";
import * as ProviderAuthorization from "./provider-authorization";
import * as ProviderEventRouting from "./provider-event-routing";

/* oxlint-disable eslint/no-underscore-dangle -- Effect and persistence result values use the standard _tag discriminator. */

/** Expected conflict when one provider event key is retried with changed facts. */
export class InboundWhatsAppEventConflict extends Schema.TaggedError<InboundWhatsAppEventConflict>()(
  "InboundWhatsAppEventConflict",
  {
    message: Schema.String,
    phoneNumberId: Schema.String,
    providerMessageId: Schema.String,
  },
) {}

/** Expected failure when inbound control-plane facts cannot be recovered. */
export class WhatsAppAdmissionPersistenceUnavailable extends Schema.TaggedError<WhatsAppAdmissionPersistenceUnavailable>()(
  "WhatsAppAdmissionPersistenceUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Construct the PostgreSQL provider-event and first-binding resolution adapter. */
export const make = (options?: { readonly now?: Effect.Effect<Date> }) =>
  Effect.gen(function* () {
    const db = yield* database;
    const authorization = yield* ProviderAuthorization.make(
      options?.now === undefined
        ? { provider: "whatsapp" }
        : { now: options.now, provider: "whatsapp" },
    );

    const route = (input: RouteInput) =>
      Effect.gen(function* () {
        const now = yield* options?.now ?? DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
        const fixed = yield* ProviderEventRouting.route(
          db,
          {
            channelIdentity: input.channelIdentity,
            contentDigest: input.contentDigest,
            eventScope: input.phoneNumberId,
            messageKind: input._tag === "TextMessage" ? "text" : "button_reply",
            provider: "whatsapp",
            providerMessageId: input.providerMessageId,
          },
          now,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new WhatsAppAdmissionPersistenceUnavailable({
                cause,
                message: "PostgreSQL could not fix the inbound WhatsApp route",
              }),
          ),
        );
        if (fixed._tag === "Conflict") {
          return yield* new InboundWhatsAppEventConflict({
            message: "The provider event key was retried with changed message facts",
            phoneNumberId: input.phoneNumberId,
            providerMessageId: input.providerMessageId,
          });
        }
        if (fixed._tag === "Incomplete") {
          return yield* new WhatsAppAdmissionPersistenceUnavailable({
            cause: fixed,
            message: "The fixed inbound WhatsApp route is incomplete",
          });
        }
        if (fixed._tag === "Unbound") return fixed;

        return fixed;
      });
    return { admit: authorization.admit, route };
  });
