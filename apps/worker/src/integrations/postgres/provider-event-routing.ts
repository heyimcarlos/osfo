import { agents } from "@osfo/db/schema/agents";
import { inboundProviderEvents } from "@osfo/db/schema/messaging";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { Database } from "../../db";
import { AgentId, ChannelBindingId, ChannelIdentity } from "../../domain";
import type { ProviderMessageId } from "../../domain";
import type { ChannelProvider } from "../../services/onboarding";
import type {
  InboundRoute,
  ProviderContentDigest,
} from "../../services/provider-message-admission";
import { readActiveBinding, readBinding } from "./channel-binding";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Drizzle transactions use Promise control flow and return tagged application outcomes. */

/** Normalized immutable facts used by both provider-event routing adapters. */
export interface Input {
  readonly channelIdentity: ChannelIdentity;
  readonly contentDigest: ProviderContentDigest;
  readonly eventScope: string;
  readonly messageKind: "button_reply" | "text";
  readonly provider: ChannelProvider;
  readonly providerMessageId: ProviderMessageId;
}

/** Shared provider-event routing outcome before adapter-specific error projection. */
export type Result = InboundRoute | { readonly _tag: "Conflict" } | { readonly _tag: "Incomplete" };

/** Expected failure while fixing one provider event to its first binding route. */
export class ProviderEventRoutingUnavailable extends Schema.TaggedError<ProviderEventRoutingUnavailable>()(
  "ProviderEventRoutingUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    provider: Schema.Literals(["telegram", "whatsapp"]),
  },
) {}

/** Fix one immutable provider event to its first observed Channel Binding and Agent. */
export const route = (
  db: Database,
  input: Input,
  now: Date,
): Effect.Effect<Result, ProviderEventRoutingUnavailable> =>
  Effect.tryPromise({
    try: () => routeTransaction(db, input, now),
    catch: (cause) =>
      new ProviderEventRoutingUnavailable({
        cause,
        message: "PostgreSQL could not fix the provider event route",
        provider: input.provider,
      }),
  });

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const routeTransaction = async (db: Database, input: Input, now: Date) =>
  db.transaction(async (transaction) => {
    await transaction.insert(inboundProviderEvents).values(input).onConflictDoNothing();
    const stored = await readEvent(transaction, input);
    if (stored === undefined) return { _tag: "Incomplete" } as const;
    if (
      stored.channelIdentity !== input.channelIdentity ||
      stored.contentDigest !== input.contentDigest ||
      stored.messageKind !== input.messageKind
    ) {
      return { _tag: "Conflict" } as const;
    }

    let bindingId = stored.resolvedChannelBindingId;
    if (stored.bindingResolvedAt === null) {
      const binding = await readActiveBinding(
        transaction,
        input.provider,
        ChannelIdentity.make(stored.channelIdentity),
      );
      bindingId = binding?.channelBindingId ?? null;
      await transaction
        .update(inboundProviderEvents)
        .set({ bindingResolvedAt: now, resolvedChannelBindingId: bindingId })
        .where(eventKey(input));
    }
    if (bindingId === null) return { _tag: "Unbound" } as const;
    const binding = await readBinding(
      transaction,
      input.provider,
      ChannelBindingId.make(bindingId),
    );
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

const readEvent = (transaction: Transaction, input: Input) =>
  transaction
    .select()
    .from(inboundProviderEvents)
    .where(eventKey(input))
    .for("update")
    .limit(1)
    .then((rows) => rows[0]);

const eventKey = (input: Input) =>
  and(
    eq(inboundProviderEvents.provider, input.provider),
    eq(inboundProviderEvents.eventScope, input.eventScope),
    eq(inboundProviderEvents.providerMessageId, input.providerMessageId),
  );
