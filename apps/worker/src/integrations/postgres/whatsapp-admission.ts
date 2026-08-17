import { agents } from "@osfo/db/schema/agents";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { inboundProviderEvents } from "@osfo/db/schema/messaging";
import { and, eq } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";

import { database } from "../../db";
import * as Billing from "../../db/billing";
import {
  AgentId,
  ChannelIdentity,
  ChannelBindingId as ChannelBindingIdSchema,
  UserId as UserIdSchema,
} from "../../domain";
import type { InboundRoute, RouteInput } from "../../services/whatsapp-admission";
import { AuthorizationContext } from "../../services/authorization";
import { readActiveBinding, readBinding } from "./channel-binding";
import * as DeletionCasePostgres from "./deletion-case";
import * as UserSuspensionPostgres from "./user-suspension";

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
export const make = (options?: {
  readonly now?: Effect.Effect<Date>;
  readonly provider?: "telegram" | "whatsapp";
}) =>
  Effect.gen(function* () {
    const provider = options?.provider ?? "whatsapp";
    const db = yield* database;
    const billing = Billing.make(db);
    const deletionCases = yield* DeletionCasePostgres.make;
    const userSuspensions = yield* UserSuspensionPostgres.make;

    const route = (input: RouteInput) =>
      Effect.gen(function* () {
        const now = yield* options?.now ?? DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
        const fixed = yield* Effect.tryPromise({
          try: () =>
            // oxlint-disable-next-line effecttsgo/async-function -- boundary: Drizzle transaction callbacks require Promise control flow.
            db.transaction(async (transaction) => {
              await transaction
                .insert(inboundProviderEvents)
                .values({
                  channelIdentity: input.channelIdentity,
                  contentDigest: input.contentDigest,
                  eventScope: input.phoneNumberId,
                  messageKind: input._tag === "TextMessage" ? "text" : "button_reply",
                  provider,
                  providerMessageId: input.providerMessageId,
                })
                .onConflictDoNothing();
              const [stored] = await transaction
                .select()
                .from(inboundProviderEvents)
                .where(
                  and(
                    eq(inboundProviderEvents.provider, provider),
                    eq(inboundProviderEvents.eventScope, input.phoneNumberId),
                    eq(inboundProviderEvents.providerMessageId, input.providerMessageId),
                  ),
                )
                .for("update")
                .limit(1);
              if (stored === undefined) return { _tag: "Incomplete" as const };
              if (!sameEvent(stored, input)) return { _tag: "Conflict" as const };

              let resolvedChannelBindingId = stored.resolvedChannelBindingId;
              if (stored.bindingResolvedAt === null) {
                const binding = await readActiveBinding(
                  transaction,
                  provider,
                  ChannelIdentity.make(stored.channelIdentity),
                );
                resolvedChannelBindingId = binding?.channelBindingId ?? null;
                await transaction
                  .update(inboundProviderEvents)
                  .set({ bindingResolvedAt: now, resolvedChannelBindingId })
                  .where(
                    and(
                      eq(inboundProviderEvents.provider, provider),
                      eq(inboundProviderEvents.eventScope, input.phoneNumberId),
                      eq(inboundProviderEvents.providerMessageId, input.providerMessageId),
                    ),
                  );
              }
              if (resolvedChannelBindingId === null) return { _tag: "Unbound" as const };

              const binding = await readBinding(
                transaction,
                provider,
                ChannelBindingIdSchema.make(resolvedChannelBindingId),
              );
              if (binding === null) return { _tag: "Incomplete" as const };
              const [bindingRoute] = await transaction
                .select({
                  agentId: agents.agentId,
                })
                .from(agents)
                .where(eq(agents.userId, binding.userId))
                .limit(1);
              if (bindingRoute === undefined) {
                return { _tag: "Incomplete" as const };
              }
              return {
                _tag: "Bound" as const,
                agentId: bindingRoute.agentId,
                channelBindingId: binding.channelBindingId,
              };
            }),
          catch: (cause) =>
            new WhatsAppAdmissionPersistenceUnavailable({
              cause,
              message: "PostgreSQL could not fix the inbound WhatsApp route",
            }),
        });
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

        return {
          _tag: "Bound",
          agentId: AgentId.make(fixed.agentId),
          channelBindingId: ChannelBindingIdSchema.make(fixed.channelBindingId),
        } as const;
      });

    const admit = (fixedRoute: Extract<InboundRoute, { readonly _tag: "Bound" }>) =>
      Effect.gen(function* () {
        const now = yield* options?.now ?? DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
        const facts = yield* Effect.tryPromise({
          // oxlint-disable-next-line effecttsgo/async-function -- boundary: this adapter composes related Drizzle reads.
          try: async () => {
            const binding = await readBinding(db, provider, fixedRoute.channelBindingId);
            if (binding === null) return null;
            const [record] = await db
              .select({
                agentId: agents.agentId,
                plan: billingSubscriptions.plan,
                planPolicyVersion: billingSubscriptions.planPolicyVersion,
              })
              .from(agents)
              .innerJoin(billingSubscriptions, eq(billingSubscriptions.userId, agents.userId))
              .where(eq(agents.userId, binding.userId))
              .limit(1);
            return record === undefined ? null : { ...binding, ...record };
          },
          catch: (cause) =>
            new WhatsAppAdmissionPersistenceUnavailable({
              cause,
              message: "PostgreSQL could not load the fixed inbound WhatsApp route",
            }),
        });
        if (facts === null || facts.agentId !== fixedRoute.agentId) {
          return yield* new WhatsAppAdmissionPersistenceUnavailable({
            cause: { facts, fixedRoute },
            message: "The fixed inbound WhatsApp route is incomplete",
          });
        }
        const userId = UserIdSchema.make(facts.userId);
        const [allowance, deletionAccess, user] = yield* Effect.all([
          billing.admit(userId, now),
          deletionCases.inspect(userId),
          userSuspensions.inspect(userId),
        ]);
        const authorization = yield* Schema.decodeEffect(AuthorizationContext)({
          allowance: { _tag: "Metered", ...allowance },
          approval: null,
          authority:
            facts.revokedAt === null
              ? {
                  _tag: "ChannelBinding",
                  channelBindingId: facts.channelBindingId,
                  userId,
                }
              : {
                  _tag: "RevokedChannelBinding",
                  channelBindingId: facts.channelBindingId,
                  userId,
                },
          deletionAccess,
          gmailConnection: null,
          liveFacts: {
            activeGmSummonsInSession: 0n,
            activeReminders: 0n,
            concurrentWorkflows: 0n,
            retainedFileBytes: 0n,
          },
          now,
          originatingAuthority: {
            _tag: "ChannelBinding",
            channelBindingId: facts.channelBindingId,
          },
          requestVendorUsdMicros: 0n,
          resourceOwnerUserId: userId,
          subscription: { plan: facts.plan, planPolicyVersion: facts.planPolicyVersion },
          user,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new WhatsAppAdmissionPersistenceUnavailable({
                cause,
                message: "PostgreSQL returned invalid WhatsApp authorization facts",
              }),
          ),
        );
        return authorization;
      });

    return { admit, route };
  });

const sameEvent = (stored: typeof inboundProviderEvents.$inferSelect, input: RouteInput): boolean =>
  stored.eventScope === input.phoneNumberId &&
  stored.channelIdentity === input.channelIdentity &&
  stored.contentDigest === input.contentDigest &&
  stored.messageKind === (input._tag === "TextMessage" ? "text" : "button_reply");
