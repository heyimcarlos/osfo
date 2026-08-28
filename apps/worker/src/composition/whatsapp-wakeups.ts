import { BrowserCrypto } from "@effect/platform-browser";
import { DateTime, Effect, Layer, Schema } from "effect";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import type { Database } from "@osfo/db";
import { Db } from "../db";
import type { ChannelLinkId, UserId } from "../domain";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { wakeUpSenderLayer } from "../integrations/whatsapp";
import { ResearchReportFollowUpPostgres } from "../integrations/postgres/research-report-follow-up";
import { ResearchReportFollowUp } from "../services/research-report-follow-up";
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
export const reminderSourceAuthority = (directory: ReminderSourceDirectory) =>
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
  });

export const reminderSourceAuthorityLayer = (directory: ReminderSourceDirectory) =>
  Layer.succeed(WhatsAppWakeUps.SourceAuthority, reminderSourceAuthority(directory));

/** PostgreSQL is the only authority for a committed Research Report follow-up source. */
export const researchReportSourceAuthority = (
  database: Database,
): WhatsAppWakeUps.SourceAuthorityInterface => {
  const followUps = ResearchReportFollowUpPostgres.make(database);
  return {
    inspect: (userId, source) => {
      if (source._tag !== "ResearchReport") return Effect.succeed(null);
      return Schema.decodeEffect(ResearchReportFollowUp.NotificationId)(source.identity).pipe(
        Effect.flatMap(followUps.inspect),
        Effect.map((notification) =>
          notification === null ||
          notification.userId !== userId ||
          notification.acceptedAt === null ||
          notification.sourceExposedAt !== null ||
          notification.whatsAppChannelLinkId === null
            ? null
            : { committedAt: notification.acceptedAt, source },
        ),
        Effect.mapError((cause) => sourceUnavailable("researchReport.inspect", cause)),
      );
    },
    pendingForUser: (userId) =>
      followUps.pendingSources(userId).pipe(
        Effect.map((notifications) =>
          notifications.flatMap((notification) =>
            notification.acceptedAt === null || notification.whatsAppChannelLinkId === null
              ? []
              : [
                  {
                    committedAt: notification.acceptedAt,
                    source: WhatsAppWakeUps.Source.cases.ResearchReport.make({
                      identity: WhatsAppWakeUps.SourceIdentity.make(notification.notificationId),
                    }),
                  },
                ],
          ),
        ),
        Effect.mapError((cause) => sourceUnavailable("researchReport.pending", cause)),
      ),
    exposePending: (userId, committed) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          Effect.forEach(
            committed.flatMap(({ source }) =>
              source._tag === "ResearchReport" ? [source.identity] : [],
            ),
            (identity) => Schema.decodeEffect(ResearchReportFollowUp.NotificationId)(identity),
          ).pipe(
            Effect.flatMap((notificationIds) =>
              followUps.exposeSources(userId, notificationIds, DateTime.toDateUtc(now)),
            ),
          ),
        ),
        Effect.mapError((cause) => sourceUnavailable("researchReport.expose", cause)),
      ),
  };
};

/** Route each source kind to its owning authority without replacing Reminder support. */
export const combinedSourceAuthority = (
  reminder: WhatsAppWakeUps.SourceAuthorityInterface,
  researchReport: WhatsAppWakeUps.SourceAuthorityInterface,
): WhatsAppWakeUps.SourceAuthorityInterface => ({
  inspect: (userId, source) =>
    source._tag === "ResearchReport"
      ? researchReport.inspect(userId, source)
      : reminder.inspect(userId, source),
  pendingForUser: (userId) =>
    Effect.all([reminder.pendingForUser(userId), researchReport.pendingForUser(userId)]).pipe(
      Effect.map(([reminders, reports]) => [...reminders, ...reports]),
    ),
  exposePending: (userId, committed) =>
    Effect.all(
      [reminder.exposePending(userId, committed), researchReport.exposePending(userId, committed)],
      { discard: true },
    ),
});

export const combinedSourceAuthorityLayer = (
  reminder: WhatsAppWakeUps.SourceAuthorityInterface,
  databaseBinding: Pick<Hyperdrive, "connectionString">,
) =>
  Layer.effect(
    WhatsAppWakeUps.SourceAuthority,
    Db.database.pipe(
      Effect.map((database) =>
        combinedSourceAuthority(reminder, researchReportSourceAuthority(database)),
      ),
    ),
  ).pipe(Layer.provide(Db.layer({ db: databaseBinding })));

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
  const sources = combinedSourceAuthorityLayer(reminderSourceAuthority(directory), env.DB);
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
        Effect.provide(layer(config, sources).pipe(Layer.provide(base))),
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
