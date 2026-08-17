import { registrationInvitations } from "@osfo/db/schema/onboarding";
import { telegramOnboardingDeliveries } from "@osfo/db/schema/telegram-onboarding-delivery";
import { and, eq, or } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";

import { database, type Database } from "../../db";
import * as Onboarding from "../../services/onboarding";
import * as TelegramDelivery from "../../services/telegram-onboarding-delivery";

/* oxlint-disable effecttsgo/async-function -- Drizzle transactions use Promise control flow. */

/** PostgreSQL implementation of the Telegram onboarding delivery lifecycle. */
export const make = Effect.gen(function* () {
  const db = yield* database;

  return TelegramDelivery.Persistence.of({
    begin: (eventId, claimToken, now) =>
      Effect.tryPromise({
        try: () => beginTransaction(db, eventId, claimToken, now),
        catch: (cause) => unavailable("beginTelegramDelivery", cause),
      }),
    complete: (eventId, claimToken, now) =>
      Effect.tryPromise({
        try: () =>
          db
            .update(telegramOnboardingDeliveries)
            .set({ appliedAt: now, leaseExpiresAt: null, state: "applied" })
            .where(
              and(
                eq(telegramOnboardingDeliveries.eventId, eventId),
                eq(telegramOnboardingDeliveries.claimToken, claimToken),
                eq(telegramOnboardingDeliveries.state, "ambiguous"),
              ),
            )
            .returning({ eventId: telegramOnboardingDeliveries.eventId }),
        catch: (cause) => unavailable("completeTelegramDelivery", cause),
      }).pipe(
        Effect.flatMap((changed) =>
          changed.length === 1
            ? Effect.void
            : Effect.fail(unavailable("completeTelegramDelivery", "Telegram event claim was lost")),
        ),
      ),
    markAmbiguous: (eventId, claimToken) =>
      Effect.tryPromise({
        try: () =>
          db
            .update(telegramOnboardingDeliveries)
            .set({ leaseExpiresAt: null, state: "ambiguous" })
            .where(
              and(
                eq(telegramOnboardingDeliveries.eventId, eventId),
                or(
                  eq(telegramOnboardingDeliveries.state, "not_applied"),
                  eq(telegramOnboardingDeliveries.state, "prepared"),
                ),
                eq(telegramOnboardingDeliveries.claimToken, claimToken),
              ),
            )
            .returning({ eventId: telegramOnboardingDeliveries.eventId }),
        catch: (cause) => unavailable("markTelegramDeliveryAmbiguous", cause),
      }).pipe(
        Effect.flatMap((changed) =>
          changed.length === 1
            ? Effect.void
            : Effect.fail(
                unavailable("markTelegramDeliveryAmbiguous", "Telegram event claim was lost"),
              ),
        ),
      ),
    prepareInvitation: (input) =>
      Effect.tryPromise({
        try: () => prepareInvitationTransaction(db, input),
        catch: (cause) => rejected("prepareTelegramInvitation", input.invitationId, cause),
      }).pipe(
        Effect.flatMap((prepared) =>
          prepared
            ? Effect.void
            : Effect.fail(
                rejected(
                  "prepareTelegramInvitation",
                  input.invitationId,
                  "Telegram event claim was lost or invitation facts conflict",
                ),
              ),
        ),
      ),
  });
});

/** Telegram delivery persistence Layer with a request-scoped database dependency. */
export const layerWithoutDependencies = Layer.effect(TelegramDelivery.Persistence, make);

const unavailable = (operation: string, cause: unknown) =>
  new Onboarding.OnboardingPersistenceUnavailable({ cause, operation });

const rejected = (operation: string, operationId: string, cause: unknown) =>
  new Onboarding.OnboardingPersistenceRejected({ cause, operation, operationId });

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const prepareInvitationTransaction = async (
  db: Database,
  input: TelegramDelivery.PrepareInvitationInput,
) =>
  db.transaction(async (transaction) => {
    const [receipt] = await transaction
      .select({ eventId: telegramOnboardingDeliveries.eventId })
      .from(telegramOnboardingDeliveries)
      .where(
        and(
          eq(telegramOnboardingDeliveries.eventId, input.eventId),
          eq(telegramOnboardingDeliveries.claimToken, input.claimToken),
          or(
            eq(telegramOnboardingDeliveries.state, "not_applied"),
            eq(telegramOnboardingDeliveries.state, "prepared"),
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (receipt === undefined) return false;
    const [liveInvitation] = await transaction
      .select({
        invitationId: registrationInvitations.invitationId,
        tokenDigest: registrationInvitations.tokenDigest,
      })
      .from(registrationInvitations)
      .where(
        and(
          eq(registrationInvitations.provider, "telegram"),
          eq(registrationInvitations.channelIdentity, input.channelIdentity),
          eq(registrationInvitations.state, "live"),
        ),
      )
      .for("update")
      .limit(1);
    if (liveInvitation !== undefined) {
      if (
        liveInvitation.invitationId !== input.invitationId ||
        liveInvitation.tokenDigest !== input.tokenDigest
      ) {
        return false;
      }
      return await markInvitationPrepared(transaction, input);
    }
    await transaction
      .insert(registrationInvitations)
      .values({
        channelIdentity: input.channelIdentity,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        invitationId: input.invitationId,
        invitedPhoneNumber: null,
        kind: "telegram_first",
        locale: input.locale,
        provider: "telegram",
        providerEventId: input.eventId,
        tokenDigest: input.tokenDigest,
      })
      .onConflictDoNothing();
    const invitation = await transaction
      .select({
        invitationId: registrationInvitations.invitationId,
        tokenDigest: registrationInvitations.tokenDigest,
      })
      .from(registrationInvitations)
      .where(
        and(
          eq(registrationInvitations.provider, "telegram"),
          eq(registrationInvitations.providerEventId, input.eventId),
        ),
      )
      .limit(1);
    if (
      invitation[0]?.invitationId !== input.invitationId ||
      invitation[0]?.tokenDigest !== input.tokenDigest
    ) {
      return false;
    }
    return await markInvitationPrepared(transaction, input);
  });

const markInvitationPrepared = async (
  transaction: Transaction,
  input: TelegramDelivery.PrepareInvitationInput,
) => {
  const changed = await transaction
    .update(telegramOnboardingDeliveries)
    .set({ state: "prepared" })
    .where(
      and(
        eq(telegramOnboardingDeliveries.eventId, input.eventId),
        eq(telegramOnboardingDeliveries.claimToken, input.claimToken),
        or(
          eq(telegramOnboardingDeliveries.state, "not_applied"),
          eq(telegramOnboardingDeliveries.state, "prepared"),
        ),
      ),
    )
    .returning({ eventId: telegramOnboardingDeliveries.eventId });
  return changed.length === 1;
};

const beginTransaction = async (db: Database, eventId: string, claimToken: string, now: Date) =>
  db.transaction(async (transaction) => {
    const read = () =>
      transaction
        .select({
          leaseExpiresAt: telegramOnboardingDeliveries.leaseExpiresAt,
          claimToken: telegramOnboardingDeliveries.claimToken,
          state: telegramOnboardingDeliveries.state,
        })
        .from(telegramOnboardingDeliveries)
        .where(eq(telegramOnboardingDeliveries.eventId, eventId))
        .for("update")
        .limit(1)
        .then((rows) => rows[0]);
    const existing = await read();
    if (existing?.state === "applied") return { _tag: "Completed" } as const;
    if (existing?.state === "ambiguous") return { _tag: "Ambiguous" } as const;
    if (existing !== undefined) {
      if (existing.leaseExpiresAt === null || existing.leaseExpiresAt.getTime() > now.getTime()) {
        return { _tag: "InProgress" } as const;
      }
      const changed = await transaction
        .update(telegramOnboardingDeliveries)
        .set({ claimToken, leaseExpiresAt: leaseExpiry(now) })
        .where(
          and(
            eq(telegramOnboardingDeliveries.eventId, eventId),
            eq(telegramOnboardingDeliveries.claimToken, existing.claimToken),
            eq(telegramOnboardingDeliveries.leaseExpiresAt, existing.leaseExpiresAt),
            or(
              eq(telegramOnboardingDeliveries.state, "not_applied"),
              eq(telegramOnboardingDeliveries.state, "prepared"),
            ),
          ),
        )
        .returning({ eventId: telegramOnboardingDeliveries.eventId });
      if (changed.length !== 1) return { _tag: "InProgress" } as const;
      return { _tag: "Claimed", claimToken } as const;
    }
    const inserted = await transaction
      .insert(telegramOnboardingDeliveries)
      .values({
        eventId,
        claimToken,
        leaseExpiresAt: leaseExpiry(now),
        state: "not_applied",
      })
      .onConflictDoNothing()
      .returning({ eventId: telegramOnboardingDeliveries.eventId });
    if (inserted.length > 0) return { _tag: "Claimed", claimToken } as const;
    const raced = await read();
    return raced?.state === "applied"
      ? ({ _tag: "Completed" } as const)
      : ({ _tag: "InProgress" } as const);
  });

const leaseExpiry = (now: Date) =>
  DateTime.toDateUtc(DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 }));
