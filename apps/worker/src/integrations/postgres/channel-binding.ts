import { channelBindings } from "@osfo/db/schema/onboarding";
import { agents } from "@osfo/db/schema/agents";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";

import * as Db from "../../db";
import { AgentId, ChannelBindingId, ChannelIdentity, UserId } from "../../domain";
import type * as ChannelBinding from "../../services/channel-binding";
import type { ChannelProvider } from "../../services/onboarding";

/* oxlint-disable effecttsgo/async-function -- Drizzle query helpers preserve caller-owned transaction scope. */

const StoredChannelBinding = Schema.Struct({
  channelBindingId: ChannelBindingId,
  channelIdentity: ChannelIdentity,
  provider: Schema.Literals(["telegram", "whatsapp"]),
  revokedAt: Schema.NullOr(Schema.Date),
  userId: UserId,
});

/** Storage-local Channel Binding facts for supported messaging providers. */
export type StoredChannelBinding = typeof StoredChannelBinding.Type;

type Transaction = Parameters<Parameters<Db.Database["transaction"]>[0]>[0];
type BindingReader = Pick<Transaction, "select">;

/** Build the current Channel Binding authority from application Postgres. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  return {
    inspect: (userId, channelBindingId) =>
      Db.execute("inspectChannelBinding", () => readBindingById(database, channelBindingId)).pipe(
        Effect.map((record) =>
          record === null || record.userId !== userId || record.revokedAt !== null
            ? ({
                _tag: "RevokedChannelBinding",
                channelBindingId,
                userId,
              } as const)
            : ({ _tag: "ChannelBinding", channelBindingId, userId } as const),
        ),
      ),
  } satisfies ChannelBinding.Interface;
});

/** Resolve one active provider binding inside a caller-owned transaction. */
export const readActiveBinding = async (
  transaction: BindingReader,
  provider: ChannelProvider,
  channelIdentity: ChannelIdentity,
): Promise<StoredChannelBinding | null> => {
  const [row] = await transaction
    .select({
      channelBindingId: channelBindings.channelBindingId,
      channelIdentity: channelBindings.channelIdentity,
      provider: channelBindings.provider,
      revokedAt: channelBindings.revokedAt,
      userId: channelBindings.userId,
    })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.provider, provider),
        eq(channelBindings.channelIdentity, channelIdentity),
        isNull(channelBindings.revokedAt),
      ),
    )
    .limit(1);
  return row === undefined ? null : decodeStoredBinding(row);
};

/** Resolve one active provider identity to its stable product Agent. */
export const resolveActiveAgentBinding = (
  database: BindingReader,
  provider: ChannelProvider,
  channelIdentity: ChannelIdentity,
) =>
  Effect.tryPromise({
    try: async () => {
      const binding = await readActiveBinding(database, provider, channelIdentity);
      if (binding === null) return null;
      const [agent] = await database
        .select({ agentId: agents.agentId })
        .from(agents)
        .where(eq(agents.userId, binding.userId))
        .limit(1);
      return agent === undefined
        ? null
        : {
            agentId: AgentId.make(agent.agentId),
            channelBindingId: binding.channelBindingId,
            userId: binding.userId,
          };
    },
    catch: (cause) => Db.dbUnavailable("resolveAgent", cause),
  });

/** Read one fixed provider binding, including its revocation fact. */
export const readBinding = async (
  database: BindingReader,
  provider: ChannelProvider,
  channelBindingId: ChannelBindingId,
): Promise<StoredChannelBinding | null> => {
  const [row] = await database
    .select({
      channelBindingId: channelBindings.channelBindingId,
      channelIdentity: channelBindings.channelIdentity,
      provider: channelBindings.provider,
      revokedAt: channelBindings.revokedAt,
      userId: channelBindings.userId,
    })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.channelBindingId, channelBindingId),
        eq(channelBindings.provider, provider),
      ),
    )
    .limit(1);
  return row === undefined ? null : decodeStoredBinding(row);
};

/** Read one fixed provider binding without assuming its provider. */
export const readBindingById = async (
  database: BindingReader,
  channelBindingId: ChannelBindingId,
): Promise<StoredChannelBinding | null> => {
  const [row] = await database
    .select({
      channelBindingId: channelBindings.channelBindingId,
      channelIdentity: channelBindings.channelIdentity,
      provider: channelBindings.provider,
      revokedAt: channelBindings.revokedAt,
      userId: channelBindings.userId,
    })
    .from(channelBindings)
    .where(eq(channelBindings.channelBindingId, channelBindingId))
    .limit(1);
  return row === undefined ? null : decodeStoredBinding(row);
};

/** Read current authority for one fixed provider binding. */
export const readCurrentBinding = async (
  database: BindingReader,
  provider: ChannelProvider,
  userId: UserId,
  channelBindingId: ChannelBindingId,
): Promise<StoredChannelBinding | null> => {
  const binding = await readBinding(database, provider, channelBindingId);
  return binding?.userId === userId && binding.revokedAt === null ? binding : null;
};

const decodeStoredBinding = Schema.decodeUnknownSync(StoredChannelBinding);
