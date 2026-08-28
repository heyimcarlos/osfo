import { BrowserCrypto } from "@effect/platform-browser";
import { Effect, Layer, Schema } from "effect";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { Db } from "../db";
import type { ChannelLinkId, UserId } from "../domain";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { wakeUpSenderLayer } from "../integrations/whatsapp";
import { WhatsAppWakeUps } from "../services/whatsapp-wakeups";

/* oxlint-disable eslint/no-underscore-dangle -- Effect/domain variants use the canonical _tag discriminator. */

const ReminderCommittedSourceEncoded = Schema.Struct({
  committedAt: Schema.DateFromString,
  sourceIdentity: WhatsAppWakeUps.SourceIdentity,
});

export interface ReminderSourceDirectory {
  readonly exposeReminderWakeUpSources: (
    userId: string,
    committed: ReadonlyArray<typeof ReminderCommittedSourceEncoded.Encoded>,
  ) => Promise<void>;
  readonly inspectReminderWakeUpSource: (
    userId: string,
    sourceIdentity: string,
  ) => Promise<typeof ReminderCommittedSourceEncoded.Encoded | null>;
  readonly pendingReminderWakeUpSources: (
    userId: string,
  ) => Promise<ReadonlyArray<typeof ReminderCommittedSourceEncoded.Encoded>>;
}

/** Bridge PostgreSQL Wake-up reconciliation to the Reminder's Agent-local source authority. */
export const reminderSourceAuthorityLayer = (directory: ReminderSourceDirectory) =>
  Layer.succeed(
    WhatsAppWakeUps.SourceAuthority,
    WhatsAppWakeUps.SourceAuthority.of({
      inspect: (userId, source) => {
        if (source._tag !== "Reminder") return Effect.succeed(null);
        return directoryCall("inspect", () =>
          directory.inspectReminderWakeUpSource(userId, source.identity),
        ).pipe(
          Effect.flatMap((committed) =>
            committed === null
              ? Effect.succeed(null)
              : Schema.decodeEffect(ReminderCommittedSourceEncoded)(committed),
          ),
          Effect.map((committed) =>
            committed === null ? null : { committedAt: committed.committedAt, source },
          ),
          Effect.mapError((cause) => sourceUnavailable("inspect", cause)),
        );
      },
      pendingForUser: (userId) =>
        directoryCall("pending", () => directory.pendingReminderWakeUpSources(userId)).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.Array(ReminderCommittedSourceEncoded))),
          Effect.map((committed) =>
            committed.map(({ committedAt, sourceIdentity }) => ({
              committedAt,
              source: WhatsAppWakeUps.Source.cases.Reminder.make({ identity: sourceIdentity }),
            })),
          ),
          Effect.mapError((cause) => sourceUnavailable("pending", cause)),
        ),
      exposePending: (userId, committed) => {
        const reminderSources = committed.flatMap(({ committedAt, source }) =>
          source._tag === "Reminder"
            ? [{ committedAt: committedAt.toISOString(), sourceIdentity: source.identity }]
            : [],
        );
        if (reminderSources.length === 0) return Effect.void;
        return directoryCall("expose", () =>
          directory.exposeReminderWakeUpSources(userId, reminderSources),
        ).pipe(Effect.mapError((cause) => sourceUnavailable("expose", cause)));
      },
    }),
  );

const directoryCall = <A>(operation: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => sourceUnavailable(operation, cause),
  });

const sourceUnavailable = (operation: string, cause: unknown) =>
  new WhatsAppWakeUps.WakeUpUnavailable({ cause, operation: `reminderSource.${operation}` });

/** Production Wake-up module with no source adapters until their owning tickets land. */
export const layer = (
  config: CloudflareConfig,
  sourceAuthorityLayer = WhatsAppWakeUps.emptySourceAuthorityLayer,
) =>
  WhatsAppWakeUps.layerWithoutDependencies.pipe(
    Layer.provide(Layer.merge(sourceAuthorityLayer, wakeUpSenderLayer(config.whatsApp))),
  );

/** Always reconcile started requests; send only with exact v1 template attestation. */
export const drainScheduled = (env: CloudflareEnv, config: CloudflareConfig) => {
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
  return Effect.runPromise(
    Effect.scoped(
      WhatsAppWakeUps.Service.pipe(
        Effect.flatMap((wakeUps) =>
          wakeUps.drainPending({ sendPending: config.whatsApp.wakeUp._tag === "Active" }),
        ),
        Effect.tap((result) =>
          Effect.logInfo("WhatsApp Wake-up scheduled drain completed").pipe(
            Effect.annotateLogs({
              accepted: result.accepted,
              ambiguous: result.ambiguous,
              canceled: result.canceled,
              rejected: result.rejected,
              templatePolicyVersion: WhatsAppWakeUps.templatePolicyVersion,
            }),
          ),
        ),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scheduled maintenance owns this complete composition.
        Effect.provide(
          layer(config, reminderSourceAuthorityLayer(directory)).pipe(Layer.provide(base)),
        ),
      ),
    ),
  ).then(() => undefined);
};

/** Consume a WhatsApp latch inside the already-owned Agent PostgreSQL runtime. */
export const consumeInbound = (
  config: CloudflareConfig,
  input: { readonly channelLinkId: ChannelLinkId; readonly userId: UserId },
  sourceAuthorityLayer = WhatsAppWakeUps.emptySourceAuthorityLayer,
) =>
  Effect.scoped(
    WhatsAppWakeUps.Service.pipe(
      Effect.flatMap((wakeUps) => wakeUps.consumeInbound(input)),
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Agent ingress owns the request-local Wake-up policy layer.
      Effect.provide(layer(config, sourceAuthorityLayer)),
    ),
  );

export * as WhatsAppWakeUpComposition from "./whatsapp-wakeups";
