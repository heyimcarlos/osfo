import { DateTime, Effect, Layer } from "effect";

import { database } from "../../db";
import * as Billing from "../../db/billing";
import { retainedCatalog } from "../../domain/plan-policy";
import * as Allowances from "../../services/allowances";
import * as MessagingAdmission from "../../services/messaging-admission";
import * as ProviderEventRouting from "./provider-event-routing";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Drizzle transaction callbacks require Promise control flow and results use Effect's _tag discriminator. */

/** PostgreSQL immutable Telegram route and accepted-message usage adapter. */
export const make = Effect.gen(function* () {
  const db = yield* database;
  const billing = Billing.make(db);
  const allowances = Allowances.make({
    billing,
    catalog: retainedCatalog,
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
  });

  return MessagingAdmission.Persistence.of({
    admit: () => Effect.void,
    recordAccepted: (receipt) =>
      allowances
        .record(
          receipt.allowancePeriodId,
          { sourceId: receipt.receiptId, sourceType: "acceptanceReceipt" },
          [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => unavailable("recordAcceptedMessage", cause)),
        ),
    route: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
        const result = yield* ProviderEventRouting.route(
          db,
          {
            channelIdentity: input.channelIdentity,
            contentDigest: input.contentDigest,
            eventScope: "telegram",
            messageKind: "text",
            provider: "telegram",
            providerMessageId: input.providerMessageId,
          },
          now,
        ).pipe(Effect.mapError((cause) => unavailable("routeProviderEvent", cause)));
        return result._tag === "Conflict"
          ? yield* unavailable("routeProviderEvent", "Provider facts conflict")
          : result._tag === "Incomplete"
            ? yield* unavailable("routeProviderEvent", "Fixed route is incomplete")
            : result;
      }),
  });
});

/** PostgreSQL Telegram admission layer awaiting its scoped database dependency. */
export const layerWithoutDependencies = Layer.effect(MessagingAdmission.Persistence, make);

const unavailable = (operation: string, cause: unknown) =>
  new MessagingAdmission.MessagingAdmissionUnavailable({
    cause,
    message: "Telegram admission is temporarily unavailable",
    operation,
  });
