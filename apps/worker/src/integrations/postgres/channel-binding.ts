import { channelBindings } from "@osfo/db/schema/onboarding";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";

import * as Db from "../../db";
import { ChannelBindingId, ChannelIdentity, UserId } from "../../domain";
import type * as ChannelBinding from "../../services/channel-binding";

/* oxlint-disable effecttsgo/async-function -- Drizzle query helpers preserve caller-owned transaction scope. */

const StoredWhatsAppBinding = Schema.Struct({
  channelBindingId: ChannelBindingId,
  channelIdentity: ChannelIdentity,
  revokedAt: Schema.NullOr(Schema.Date),
  userId: UserId,
});

/** Storage-local WhatsApp Channel Binding facts. */
export type StoredWhatsAppBinding = typeof StoredWhatsAppBinding.Type;

type Transaction = Parameters<Parameters<Db.Database["transaction"]>[0]>[0];
type BindingReader = Pick<Transaction, "select">;

/** Build the current Channel Binding authority from application Postgres. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  return {
    inspect: (userId, channelBindingId) =>
      Db.execute("inspectChannelBinding", () =>
        readCurrentWhatsAppBinding(database, userId, channelBindingId),
      ).pipe(
        Effect.map((record) =>
          record === null
            ? ({ _tag: "RevokedChannelBinding", channelBindingId, userId } as const)
            : ({ _tag: "ChannelBinding", channelBindingId, userId } as const),
        ),
      ),
  } satisfies ChannelBinding.Interface;
});

/** Resolve one active WhatsApp binding inside a caller-owned transaction. */
export const readActiveWhatsAppBinding = async (
  transaction: BindingReader,
  channelIdentity: ChannelIdentity,
): Promise<StoredWhatsAppBinding | null> => {
  const [row] = await transaction
    .select({
      channelBindingId: channelBindings.channelBindingId,
      channelIdentity: channelBindings.channelIdentity,
      revokedAt: channelBindings.revokedAt,
      userId: channelBindings.userId,
    })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.provider, "whatsapp"),
        eq(channelBindings.channelIdentity, channelIdentity),
        isNull(channelBindings.revokedAt),
      ),
    )
    .limit(1);
  return decodeStoredBinding(row);
};

/** Read one fixed WhatsApp binding, including its revocation fact. */
export const readWhatsAppBinding = async (
  database: BindingReader,
  channelBindingId: ChannelBindingId,
): Promise<StoredWhatsAppBinding | null> => {
  const [row] = await database
    .select({
      channelBindingId: channelBindings.channelBindingId,
      channelIdentity: channelBindings.channelIdentity,
      revokedAt: channelBindings.revokedAt,
      userId: channelBindings.userId,
    })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.channelBindingId, channelBindingId),
        eq(channelBindings.provider, "whatsapp"),
      ),
    )
    .limit(1);
  return decodeStoredBinding(row);
};

/** Read current authority for one fixed WhatsApp binding. */
export const readCurrentWhatsAppBinding = async (
  database: BindingReader,
  userId: UserId,
  channelBindingId: ChannelBindingId,
): Promise<StoredWhatsAppBinding | null> => {
  const binding = await readWhatsAppBinding(database, channelBindingId);
  return binding?.userId === userId && binding.revokedAt === null ? binding : null;
};

const decodeStoredBinding = (
  row: typeof StoredWhatsAppBinding.Encoded | undefined,
): StoredWhatsAppBinding | null =>
  row === undefined ? null : Schema.decodeSync(StoredWhatsAppBinding)(row);
