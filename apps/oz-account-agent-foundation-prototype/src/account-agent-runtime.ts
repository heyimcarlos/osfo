import { eq, sql } from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleDurableObject } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { activationAudit, channelBindings } from "./directory-schema.ts";
import { foundationReceipts, reminderDeliveries } from "./agent-schema.ts";
import migrations from "./agent-migrations/migrations.js";
import { ChannelBindingMismatch, PrototypePersistenceError } from "./prototype-errors.ts";

export type FoundationSnapshot = {
  readonly activation: {
    readonly count: number;
    readonly lastActivationId: string;
  } | null;
  readonly receipts: ReadonlyArray<{
    readonly accepted: boolean;
    readonly messageId: string;
    readonly status: string;
    readonly submissionId: string;
  }>;
  readonly reminders: ReadonlyArray<{
    readonly reminderId: string;
    readonly text: string;
  }>;
};

class FoundationStore extends Context.Service<
  FoundationStore,
  {
    readonly assertChannelBinding: (
      channelIdentity: string,
      expectedAgentId: string,
    ) => Effect.Effect<void, ChannelBindingMismatch | PrototypePersistenceError>;
    readonly recordActivation: (
      agentId: string,
      activationId: string,
    ) => Effect.Effect<void, PrototypePersistenceError>;
    readonly recordReceipt: (input: {
      readonly accepted: boolean;
      readonly messageId: string;
      readonly status: string;
      readonly submissionId: string;
    }) => Effect.Effect<void, PrototypePersistenceError>;
    readonly recordReminder: (
      reminderId: string,
      text: string,
    ) => Effect.Effect<void, PrototypePersistenceError>;
    readonly snapshot: (
      agentId: string,
    ) => Effect.Effect<FoundationSnapshot, PrototypePersistenceError>;
  }
>()("@osfo/prototype/FoundationStore") {}

const persistence = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new PrototypePersistenceError({ cause, operation }),
    try: run,
  });

const makeFoundationStoreLayer = (input: {
  readonly directory: D1Database;
  readonly storage: DurableObjectStorage;
}) =>
  Layer.effect(
    FoundationStore,
    Effect.gen(function* () {
      const directory = drizzleD1(input.directory);
      const agent = drizzleDurableObject(input.storage);
      yield* persistence("migrate account-agent SQLite", () =>
        Promise.resolve(migrate(agent, migrations)).then(() => undefined),
      );

      return {
        assertChannelBinding: (channelIdentity, expectedAgentId) =>
          Effect.gen(function* () {
            const rows = yield* persistence("read Channel Binding", () =>
              directory
                .select({ agentId: channelBindings.agentId })
                .from(channelBindings)
                .where(eq(channelBindings.channelIdentity, channelIdentity)),
            );
            const actualAgentId = rows[0]?.agentId;
            if (actualAgentId !== expectedAgentId) {
              return yield* new ChannelBindingMismatch({
                actualAgentId,
                channelIdentity,
                expectedAgentId,
              });
            }
          }),
        recordActivation: (agentId, activationId) =>
          persistence("record Durable Object activation", () =>
            directory
              .insert(activationAudit)
              .values({
                activationCount: 1,
                agentId,
                lastActivatedAt: Date.now(),
                lastActivationId: activationId,
              })
              .onConflictDoUpdate({
                set: {
                  activationCount: sql`${activationAudit.activationCount} + 1`,
                  lastActivatedAt: Date.now(),
                  lastActivationId: activationId,
                },
                target: activationAudit.agentId,
              })
              .then(() => undefined),
          ),
        recordReceipt: (receipt) =>
          persistence("record Think submission receipt", () =>
            agent
              .insert(foundationReceipts)
              .values({ ...receipt, recordedAt: Date.now() })
              .onConflictDoNothing()
              .then(() => undefined),
          ),
        recordReminder: (reminderId, text) =>
          persistence("record alarm delivery", () =>
            agent
              .insert(reminderDeliveries)
              .values({ deliveredAt: Date.now(), reminderId, text })
              .onConflictDoNothing()
              .then(() => undefined),
          ),
        snapshot: (agentId) =>
          Effect.gen(function* () {
            const [activationRows, receipts, reminders] = yield* Effect.all([
              persistence("read activation audit", () =>
                directory
                  .select()
                  .from(activationAudit)
                  .where(eq(activationAudit.agentId, agentId)),
              ),
              persistence("read account-agent receipts", () =>
                agent.select().from(foundationReceipts),
              ),
              persistence("read alarm deliveries", () => agent.select().from(reminderDeliveries)),
            ]);
            const activation = activationRows[0];
            return {
              activation: activation
                ? {
                    count: activation.activationCount,
                    lastActivationId: activation.lastActivationId,
                  }
                : null,
              receipts: receipts.map((receipt) => ({
                accepted: receipt.accepted,
                messageId: receipt.messageId,
                status: receipt.status,
                submissionId: receipt.submissionId,
              })),
              reminders: reminders.map((reminder) => ({
                reminderId: reminder.reminderId,
                text: reminder.text,
              })),
            };
          }),
      };
    }),
  );

export class AccountAgentRuntime {
  readonly #runtime: ManagedRuntime.ManagedRuntime<FoundationStore, PrototypePersistenceError>;

  private constructor(input: {
    readonly directory: D1Database;
    readonly storage: DurableObjectStorage;
  }) {
    this.#runtime = ManagedRuntime.make(makeFoundationStoreLayer(input));
  }

  static make(input: {
    readonly directory: D1Database;
    readonly storage: DurableObjectStorage;
  }): AccountAgentRuntime {
    return new AccountAgentRuntime(input);
  }

  run<A, E>(effect: Effect.Effect<A, E, FoundationStore>): Promise<A> {
    return this.#runtime.runPromise(effect);
  }
}

export const assertChannelBinding = (channelIdentity: string, agentId: string) =>
  FoundationStore.use((store) => store.assertChannelBinding(channelIdentity, agentId));

export const recordActivation = (agentId: string, activationId: string) =>
  FoundationStore.use((store) => store.recordActivation(agentId, activationId));

export const recordReceipt = (input: {
  readonly accepted: boolean;
  readonly messageId: string;
  readonly status: string;
  readonly submissionId: string;
}) => FoundationStore.use((store) => store.recordReceipt(input));

export const recordReminder = (reminderId: string, text: string) =>
  FoundationStore.use((store) => store.recordReminder(reminderId, text));

export const readFoundationSnapshot = (agentId: string) =>
  FoundationStore.use((store) => store.snapshot(agentId));
