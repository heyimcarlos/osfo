import { agents } from "@osfo/db/schema/agents";
import { inboundProviderEvents } from "@osfo/db/schema/messaging";
import { and, eq } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";

import { database, type Database } from "../../db";
import * as Billing from "../../db/billing";
import { AgentId, ChannelBindingId, ChannelIdentity } from "../../domain";
import { retainedCatalog } from "../../domain/plan-policy";
import * as Allowances from "../../services/allowances";
import * as MessagingAdmission from "../../services/messaging-admission";
import { readActiveBinding, readBinding } from "./channel-binding";

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
        const result = yield* Effect.tryPromise({
          try: () => routeTransaction(db, input, now),
          catch: (cause) => unavailable("routeProviderEvent", cause),
        });
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

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const routeTransaction = async (
  db: Database,
  input: MessagingAdmission.TelegramRouteInput,
  now: Date,
) =>
  db.transaction(async (transaction) => {
    await transaction
      .insert(inboundProviderEvents)
      .values({
        channelIdentity: input.channelIdentity,
        contentDigest: input.contentDigest,
        eventScope: "telegram",
        messageKind: "text",
        provider: "telegram",
        providerMessageId: input.providerMessageId,
      })
      .onConflictDoNothing();
    const stored = await readEvent(transaction, input);
    if (stored === undefined) return { _tag: "Incomplete" } as const;
    if (
      stored.channelIdentity !== input.channelIdentity ||
      stored.contentDigest !== input.contentDigest ||
      stored.messageKind !== "text"
    ) {
      return { _tag: "Conflict" } as const;
    }

    let bindingId = stored.resolvedChannelBindingId;
    if (stored.bindingResolvedAt === null) {
      const binding = await readActiveBinding(
        transaction,
        "telegram",
        ChannelIdentity.make(stored.channelIdentity),
      );
      bindingId = binding?.channelBindingId ?? null;
      await transaction
        .update(inboundProviderEvents)
        .set({ bindingResolvedAt: now, resolvedChannelBindingId: bindingId })
        .where(eventKey(input));
    }
    if (bindingId === null) return { _tag: "Unbound" } as const;
    const binding = await readBinding(transaction, "telegram", ChannelBindingId.make(bindingId));
    if (binding === null) return { _tag: "Incomplete" } as const;
    const [fixedRoute] = await transaction
      .select({ agentId: agents.agentId })
      .from(agents)
      .where(eq(agents.userId, binding.userId))
      .limit(1);
    return fixedRoute === undefined
      ? ({ _tag: "Incomplete" } as const)
      : ({
          _tag: "Bound",
          agentId: AgentId.make(fixedRoute.agentId),
          channelBindingId: ChannelBindingId.make(bindingId),
        } as const);
  });

const readEvent = (transaction: Transaction, input: MessagingAdmission.TelegramRouteInput) =>
  transaction
    .select()
    .from(inboundProviderEvents)
    .where(eventKey(input))
    .for("update")
    .limit(1)
    .then((rows) => rows[0]);

const eventKey = (input: MessagingAdmission.TelegramRouteInput) =>
  and(
    eq(inboundProviderEvents.provider, "telegram"),
    eq(inboundProviderEvents.eventScope, "telegram"),
    eq(inboundProviderEvents.providerMessageId, input.providerMessageId),
  );

const unavailable = (operation: string, cause: unknown) =>
  new MessagingAdmission.MessagingAdmissionUnavailable({
    cause,
    message: "Telegram admission is temporarily unavailable",
    operation,
  });
