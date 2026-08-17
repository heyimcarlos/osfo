import { agents } from "@osfo/db/schema/agents";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { inboundWhatsAppEvents } from "@osfo/db/schema/messaging";
import { channelBindings } from "@osfo/db/schema/onboarding";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";

import { database } from "../../db";
import * as Billing from "../../db/billing";
import {
  AgentId,
  ChannelBindingId as ChannelBindingIdSchema,
  UserId as UserIdSchema,
} from "../../domain";
import type { RouteInput } from "../../services/whatsapp-admission";
import { AuthorizationContext } from "../../services/authorization";

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
    const billing = Billing.make(db);

    const route = (input: RouteInput) =>
      Effect.gen(function* () {
        const now = yield* options?.now ?? DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
        const fixed = yield* Effect.tryPromise({
          try: () =>
            // oxlint-disable-next-line effecttsgo/async-function -- boundary: Drizzle transaction callbacks require Promise control flow.
            db.transaction(async (transaction) => {
              await transaction
                .insert(inboundWhatsAppEvents)
                .values({
                  channelIdentity: input.channelIdentity,
                  contentDigest: input.contentDigest,
                  messageKind: input._tag === "TextMessage" ? "text" : "button_reply",
                  phoneNumberId: input.phoneNumberId,
                  providerMessageId: input.providerMessageId,
                })
                .onConflictDoNothing();
              const [stored] = await transaction
                .select()
                .from(inboundWhatsAppEvents)
                .where(
                  and(
                    eq(inboundWhatsAppEvents.phoneNumberId, input.phoneNumberId),
                    eq(inboundWhatsAppEvents.providerMessageId, input.providerMessageId),
                  ),
                )
                .for("update")
                .limit(1);
              if (stored === undefined) return { _tag: "Incomplete" as const };
              if (!sameEvent(stored, input)) return { _tag: "Conflict" as const };

              let resolvedChannelBindingId = stored.resolvedChannelBindingId;
              if (stored.bindingResolvedAt === null) {
                const [binding] = await transaction
                  .select({ channelBindingId: channelBindings.channelBindingId })
                  .from(channelBindings)
                  .where(
                    and(
                      eq(channelBindings.provider, "whatsapp"),
                      eq(channelBindings.channelIdentity, stored.channelIdentity),
                      isNull(channelBindings.revokedAt),
                    ),
                  )
                  .limit(1);
                resolvedChannelBindingId = binding?.channelBindingId ?? null;
                await transaction
                  .update(inboundWhatsAppEvents)
                  .set({ bindingResolvedAt: now, resolvedChannelBindingId })
                  .where(
                    and(
                      eq(inboundWhatsAppEvents.phoneNumberId, input.phoneNumberId),
                      eq(inboundWhatsAppEvents.providerMessageId, input.providerMessageId),
                    ),
                  );
              }
              if (resolvedChannelBindingId === null) return { _tag: "Unbound" as const };

              const [bindingRoute] = await transaction
                .select({
                  agentId: agents.agentId,
                  channelBindingId: channelBindings.channelBindingId,
                  plan: billingSubscriptions.plan,
                  planPolicyVersion: billingSubscriptions.planPolicyVersion,
                  revokedAt: channelBindings.revokedAt,
                  userId: channelBindings.userId,
                })
                .from(channelBindings)
                .innerJoin(agents, eq(agents.userId, channelBindings.userId))
                .innerJoin(
                  billingSubscriptions,
                  eq(billingSubscriptions.userId, channelBindings.userId),
                )
                .where(eq(channelBindings.channelBindingId, resolvedChannelBindingId))
                .limit(1);
              if (bindingRoute === undefined) {
                return { _tag: "Incomplete" as const };
              }
              return { _tag: "Bound" as const, ...bindingRoute };
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

        const userId = UserIdSchema.make(fixed.userId);
        const allowance = yield* billing.admit(userId, now);
        const authorization = yield* Schema.decodeEffect(AuthorizationContext)({
          allowance: { _tag: "Metered", ...allowance },
          approval: null,
          authority:
            fixed.revokedAt === null
              ? {
                  _tag: "ChannelBinding",
                  channelBindingId: fixed.channelBindingId,
                  userId,
                }
              : {
                  _tag: "RevokedChannelBinding",
                  channelBindingId: fixed.channelBindingId,
                  userId,
                },
          deletionAccess: { _tag: "DeletionAccessAvailable" },
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
            channelBindingId: fixed.channelBindingId,
          },
          requestVendorUsdMicros: 0n,
          resourceOwnerUserId: userId,
          subscription: { plan: fixed.plan, planPolicyVersion: fixed.planPolicyVersion },
          user: { _tag: "ActiveUser", userId },
        }).pipe(
          Effect.mapError(
            (cause) =>
              new WhatsAppAdmissionPersistenceUnavailable({
                cause,
                message: "PostgreSQL returned invalid WhatsApp authorization facts",
              }),
          ),
        );
        return {
          _tag: "Bound",
          agentId: AgentId.make(fixed.agentId),
          authorization,
          channelBindingId: ChannelBindingIdSchema.make(fixed.channelBindingId),
        } as const;
      });

    return { route };
  });

const sameEvent = (stored: typeof inboundWhatsAppEvents.$inferSelect, input: RouteInput): boolean =>
  stored.channelIdentity === input.channelIdentity &&
  stored.contentDigest === input.contentDigest &&
  stored.messageKind === (input._tag === "TextMessage" ? "text" : "button_reply");
