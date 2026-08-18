import { Effect, Schema } from "effect";

import { database } from "../../db";
import type { RouteInput } from "../../services/whatsapp-admission";
import * as ProviderAuthorization from "./provider-authorization";
import { resolveActiveAgentBinding } from "./channel-binding";

/* oxlint-disable eslint/no-underscore-dangle -- Effect and persistence result values use the standard _tag discriminator. */

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
      resolveActiveAgentBinding(db, "whatsapp", input.channelIdentity).pipe(
        Effect.map((binding) =>
          binding === null
            ? ({ _tag: "Unbound" } as const)
            : ({
                _tag: "Bound",
                agentId: binding.agentId,
                channelBindingId: binding.channelBindingId,
              } as const),
        ),
        Effect.mapError(
          (cause) =>
            new WhatsAppAdmissionPersistenceUnavailable({
              cause,
              message: "PostgreSQL could not resolve the inbound WhatsApp route",
            }),
        ),
      );
    return { admit: authorization.admit, route };
  });
