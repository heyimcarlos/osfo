import { users } from "@osfo/db/schema/auth";
import { channelLinks } from "@osfo/db/schema/channel-links";
import { whatsappWakeups, whatsappWakeupSources } from "@osfo/db/schema/whatsapp-wakeups";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Context, Crypto, DateTime, Duration, Effect, Encoding, Layer, Schema } from "effect";

import { Db } from "../db";
import { ChannelLinkId, UserId } from "../domain";

/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Drizzle transactions are Promise boundaries and Effect/domain variants use the canonical _tag discriminator. */

export const templatePolicyVersion = "whatsapp-wakeup-v1" as const;
export const templatePolicy = {
  translations: {
    en: "Osfo has an update. Reply here to continue.",
    es: "Osfo tiene una actualización. Responde aquí para continuar.",
  },
  variables: [],
  version: templatePolicyVersion,
} as const;

/** Stable identity for one source-owned Wake-up request. */
export const WakeUpId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand("WhatsAppWakeUpId"),
);
export type WakeUpId = typeof WakeUpId.Type;

/** Opaque committed result identity retained by its owning module. */
export const SourceIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand("WhatsAppWakeUpSourceIdentity"));
export type SourceIdentity = typeof SourceIdentity.Type;

/** Opaque bounded correlation safe for logs and company-cost reconciliation. */
export const TraceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand("WhatsAppWakeUpTraceId"),
);
export type TraceId = typeof TraceId.Type;

/** The only v1 owners allowed to ask a User to return to WhatsApp. */
export const Source = Schema.TaggedUnion({
  Reminder: { identity: SourceIdentity },
  ResearchReport: { identity: SourceIdentity },
  DocumentBuild: { identity: SourceIdentity },
  ScheduledEmail: { identity: SourceIdentity },
});
export type Source = typeof Source.Type;

/** One committed source fact safe to expose to the owning Agent before a turn. */
export const CommittedSource = Schema.Struct({
  committedAt: Schema.Date,
  source: Source,
});
export type CommittedSource = typeof CommittedSource.Type;

/** Current source authority, implemented by Reminder and Workflow owners. */
export interface SourceAuthorityInterface {
  readonly inspect: (
    userId: UserId,
    source: Source,
  ) => Effect.Effect<CommittedSource | null, WakeUpUnavailable>;
  readonly pendingForUser: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<CommittedSource>, WakeUpUnavailable>;
  readonly exposePending: (
    userId: UserId,
    committed: ReadonlyArray<CommittedSource>,
  ) => Effect.Effect<void, WakeUpUnavailable>;
}

export class SourceAuthority extends Context.Service<SourceAuthority, SourceAuthorityInterface>()(
  "@osfo/WhatsAppWakeUps/SourceAuthority",
) {}

/** Validated WhatsApp endpoint kept inside the transport adapter. */
export const EndpointIdentity = Schema.String.check(Schema.isPattern(/^\d{5,20}$/u)).pipe(
  Schema.brand("WhatsAppWakeUpEndpointIdentity"),
);
export type EndpointIdentity = typeof EndpointIdentity.Type;

export const Locale = Schema.Literals(["en", "es"]);
export type Locale = typeof Locale.Type;

/** Official-adapter outcome when Meta proved that it rejected the request. */
export class ProviderRejected extends Schema.TaggedError<ProviderRejected>()("ProviderRejected", {
  cause: Schema.Defect(),
}) {}

/** Official-adapter outcome when Osfo cannot prove that Meta rejected the request. */
export class ProviderAmbiguous extends Schema.TaggedError<ProviderAmbiguous>()(
  "ProviderAmbiguous",
  {
    cause: Schema.Defect(),
    failureClass: Schema.Literals(["providerTimeout", "connectionLost", "malformedSuccess"]),
  },
) {}

/** The only proactive WhatsApp operation application code can invoke. */
export interface SenderInterface {
  readonly sendTemplate: (input: {
    readonly endpoint: EndpointIdentity;
    readonly locale: Locale;
  }) => Effect.Effect<string, ProviderRejected | ProviderAmbiguous>;
}

export class Sender extends Context.Service<Sender, SenderInterface>()(
  "@osfo/WhatsAppWakeUps/Sender",
) {}

/** Safe failure for unavailable authority, persistence, or activation. */
export class WakeUpUnavailable extends Schema.TaggedError<WakeUpUnavailable>()(
  "WhatsAppWakeUpUnavailable",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
  },
) {}

/** Exact identity reuse with changed authority facts. */
export class WakeUpConflict extends Schema.TaggedError<WakeUpConflict>()("WhatsAppWakeUpConflict", {
  wakeUpId: WakeUpId,
}) {}

export interface RequestInput {
  readonly channelLinkId: ChannelLinkId;
  readonly source: Source;
  readonly traceId: TraceId;
  readonly userId: UserId;
  readonly wakeUpId: WakeUpId;
}

export type RequestResult =
  | { readonly _tag: "Created"; readonly wakeUpId: WakeUpId }
  | { readonly _tag: "Replayed"; readonly wakeUpId: WakeUpId }
  | { readonly _tag: "Coalesced"; readonly wakeUpId: WakeUpId };

export interface ConsumeResult {
  readonly pending: ReadonlyArray<CommittedSource>;
  readonly wakeUpId: WakeUpId;
}

export interface DrainResult {
  readonly accepted: number;
  readonly ambiguous: number;
  readonly canceled: number;
  readonly rejected: number;
}

export interface Interface {
  readonly request: (
    input: RequestInput,
  ) => Effect.Effect<RequestResult, WakeUpConflict | WakeUpUnavailable>;
  readonly drainPending: (options?: {
    readonly leaseDuration?: Duration.Input;
    readonly limit?: number;
    readonly requestTimeout?: Duration.Input;
    readonly sendPending?: boolean;
  }) => Effect.Effect<DrainResult, WakeUpUnavailable>;
  readonly consumeInbound: (input: {
    readonly channelLinkId: ChannelLinkId;
    readonly userId: UserId;
  }) => Effect.Effect<ConsumeResult | null, WakeUpUnavailable>;
  readonly cancelSource: (input: {
    readonly source: Source;
    readonly userId: UserId;
  }) => Effect.Effect<void, WakeUpUnavailable>;
  readonly cancelChannelLink: (
    channelLinkId: ChannelLinkId,
  ) => Effect.Effect<void, WakeUpUnavailable>;
  readonly deleteUser: (userId: UserId) => Effect.Effect<void, WakeUpUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@osfo/WhatsAppWakeUps") {}

const activeStates = ["pending", "requested", "accepted", "ambiguous"] as const;

/** Construct the complete latch lifecycle over PostgreSQL and the fixed sender. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  const crypto = yield* Crypto.Crypto;
  const sender = yield* Sender;
  const sourceAuthority = yield* SourceAuthority;

  const request = Effect.fn("WhatsAppWakeUps.request")(function* (input: RequestInput) {
    const committed = yield* sourceAuthority.inspect(input.userId, input.source);
    if (committed === null || !sameSource(committed.source, input.source)) {
      return yield* unavailable("request.sourceAuthority", input.source);
    }
    const authority = yield* loadAuthority(input.userId, input.channelLinkId);
    if (authority === null)
      return yield* unavailable("request.channelAuthority", input.channelLinkId);
    const locale = yield* Schema.decodeUnknownEffect(Locale)(authority.locale).pipe(
      Effect.mapError((cause) => unavailable("request.locale", cause)),
    );
    const endpoint = yield* decodeEndpoint(authority.endpoint, "request.endpoint");
    const endpointFingerprint = yield* digest(crypto, endpoint, "request.endpointFingerprint");
    const fingerprintJson = yield* Schema.encodeEffect(FingerprintJson)({
      channelLinkId: input.channelLinkId,
      endpointFingerprint,
      locale,
      source: encodeSource(input.source),
      templatePolicyVersion,
      userId: input.userId,
    }).pipe(Effect.mapError((cause) => unavailable("request.fingerprintEncoding", cause)));
    const fingerprint = yield* digest(crypto, fingerprintJson, "request.fingerprint");
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const sourceKind = sourceKindOf(input.source);
    const result = yield* attempt("request.persist", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`,
        );
        const [user] = await transaction
          .select({ locale: users.locale, registrationCompletedAt: users.registrationCompletedAt })
          .from(users)
          .where(eq(users.id, input.userId))
          .for("update")
          .limit(1);
        if (user === undefined || user.registrationCompletedAt === null || user.locale !== locale) {
          return { _tag: "Unavailable" as const };
        }
        const [deletionCase] = await transaction
          .select({ id: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(eq(deletionCases.user_id, input.userId))
          .limit(1);
        const [suspension] = await transaction
          .select({ action: userSuspensionEvents.action })
          .from(userSuspensionEvents)
          .where(eq(userSuspensionEvents.user_id, input.userId))
          .orderBy(desc(userSuspensionEvents.occurred_at), desc(userSuspensionEvents.event_id))
          .limit(1);
        if (deletionCase !== undefined || suspension?.action === "suspended") {
          return { _tag: "Unavailable" as const };
        }
        const [link] = await transaction
          .select({
            authorId: channelLinks.author_id,
            channelId: channelLinks.channel_id,
            revokedAt: channelLinks.revoked_at,
            userId: channelLinks.user_id,
          })
          .from(channelLinks)
          .where(eq(channelLinks.channel_link_id, input.channelLinkId))
          .for("update")
          .limit(1);
        if (
          link === undefined ||
          link.userId !== input.userId ||
          link.channelId !== "whatsapp" ||
          link.revokedAt !== null ||
          link.authorId !== endpoint
        ) {
          return { _tag: "Unavailable" as const };
        }
        const [exact] = await transaction
          .select({
            fingerprint: whatsappWakeupSources.fingerprint,
            wakeUpId: whatsappWakeupSources.wakeup_id,
          })
          .from(whatsappWakeupSources)
          .where(eq(whatsappWakeupSources.request_wakeup_id, input.wakeUpId))
          .limit(1);
        if (exact !== undefined) {
          return exact.fingerprint === fingerprint
            ? { _tag: "Replayed" as const, wakeUpId: exact.wakeUpId }
            : { _tag: "Conflict" as const };
        }
        const [active] = await transaction
          .select({ wakeUpId: whatsappWakeups.wakeup_id })
          .from(whatsappWakeups)
          .where(
            and(
              eq(whatsappWakeups.user_id, input.userId),
              inArray(whatsappWakeups.state, activeStates),
            ),
          )
          .limit(1);
        if (active !== undefined) {
          await transaction.insert(whatsappWakeupSources).values({
            created_at: now,
            fingerprint,
            request_wakeup_id: input.wakeUpId,
            source_committed_at: committed.committedAt,
            source_identity: input.source.identity,
            source_kind: sourceKind,
            trace_id: input.traceId,
            wakeup_id: active.wakeUpId,
          });
          return { _tag: "Coalesced" as const, wakeUpId: active.wakeUpId };
        }
        await transaction.insert(whatsappWakeups).values({
          channel_link_id: input.channelLinkId,
          created_at: now,
          endpoint_fingerprint: endpointFingerprint,
          fingerprint,
          locale,
          source_committed_at: committed.committedAt,
          source_identity: input.source.identity,
          source_kind: sourceKind,
          state: "pending",
          template_policy_version: templatePolicyVersion,
          trace_id: input.traceId,
          updated_at: now,
          user_id: input.userId,
          wakeup_id: input.wakeUpId,
        });
        await transaction.insert(whatsappWakeupSources).values({
          created_at: now,
          fingerprint,
          request_wakeup_id: input.wakeUpId,
          source_committed_at: committed.committedAt,
          source_identity: input.source.identity,
          source_kind: sourceKind,
          trace_id: input.traceId,
          wakeup_id: input.wakeUpId,
        });
        return { _tag: "Created" as const };
      }),
    );
    if (result._tag === "Conflict") return yield* new WakeUpConflict({ wakeUpId: input.wakeUpId });
    if (result._tag === "Unavailable") {
      return yield* unavailable("request.recheck", input.channelLinkId);
    }
    return result._tag === "Coalesced" || result._tag === "Replayed"
      ? { _tag: result._tag, wakeUpId: WakeUpId.make(result.wakeUpId) }
      : { _tag: result._tag, wakeUpId: input.wakeUpId };
  });

  const drainPending = Effect.fn("WhatsAppWakeUps.drainPending")(function* (
    options: {
      readonly leaseDuration?: Duration.Input;
      readonly limit?: number;
      readonly requestTimeout?: Duration.Input;
      readonly sendPending?: boolean;
    } = {},
  ) {
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const leaseDuration = Duration.fromInputUnsafe(options.leaseDuration ?? { minutes: 2 });
    const requestTimeout = Duration.fromInputUnsafe(options.requestTimeout ?? { minutes: 2 });
    const recovered = yield* reconcileStaleRequested(requestTimeout);
    const counts = {
      accepted: 0,
      ambiguous: recovered.ambiguous,
      canceled: recovered.canceled,
      rejected: 0,
    };
    if (options.sendPending === false) return counts;
    for (let index = 0; index < limit; index += 1) {
      const claim = yield* claimPending(leaseDuration);
      if (claim === null) break;
      const authorizedSources = yield* retainAuthorizedSources(claim.userId, claim.wakeUpId);
      if (authorizedSources.length === 0) {
        if (yield* cancelClaim(claim.wakeUpId, claim.leaseId, claim.userId, "sourceCanceled")) {
          counts.canceled += 1;
        }
        continue;
      }
      const authority = yield* loadAuthority(claim.userId, claim.channelLinkId);
      if (authority === null || authority.locale !== claim.locale) {
        if (yield* cancelClaim(claim.wakeUpId, claim.leaseId, claim.userId, "authorityLost")) {
          counts.canceled += 1;
        }
        continue;
      }
      const locale = yield* Schema.decodeUnknownEffect(Locale)(claim.locale).pipe(
        Effect.mapError((cause) => unavailable("drain.locale", cause)),
      );
      const endpoint = yield* decodeEndpoint(authority.endpoint, "drain.endpoint");
      const endpointFingerprint = yield* digest(crypto, endpoint, "drain.endpointFingerprint");
      if (endpointFingerprint !== claim.endpointFingerprint) {
        if (yield* cancelClaim(claim.wakeUpId, claim.leaseId, claim.userId, "authorityLost")) {
          counts.canceled += 1;
        }
        continue;
      }
      const requested = yield* markRequested({ ...claim, locale });
      if (requested === "canceled") {
        counts.canceled += 1;
        continue;
      }
      if (requested === "lost") continue;
      const outcome = yield* sender.sendTemplate({ endpoint, locale }).pipe(
        Effect.match({
          onFailure: (failure) =>
            failure._tag === "ProviderRejected"
              ? { _tag: "rejected" as const, failureClass: "providerRejected" as const }
              : { _tag: "ambiguous" as const, failureClass: failure.failureClass },
          onSuccess: (providerMessageId) => ({ _tag: "accepted" as const, providerMessageId }),
        }),
      );
      const providerMessageIdHash =
        outcome._tag === "accepted"
          ? yield* digest(crypto, outcome.providerMessageId, "drain.providerMessageId")
          : null;
      yield* settle(claim.wakeUpId, outcome, providerMessageIdHash);
      yield* Effect.logInfo("WhatsApp Wake-up provider request settled").pipe(
        Effect.annotateLogs({
          locale,
          outcome: outcome._tag,
          sourceKind: claim.sourceKind,
          templatePolicyVersion,
          traceId: claim.traceId,
          wakeUpId: claim.wakeUpId,
        }),
      );
      counts[outcome._tag] += 1;
    }
    return counts;
  });

  const consumeInbound = Effect.fn("WhatsAppWakeUps.consumeInbound")(function* (input: {
    readonly channelLinkId: ChannelLinkId;
    readonly userId: UserId;
  }) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const consumed = yield* attempt("consumeInbound", () =>
      database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ state: whatsappWakeups.state, wakeUpId: whatsappWakeups.wakeup_id })
          .from(whatsappWakeups)
          .where(
            and(
              eq(whatsappWakeups.user_id, input.userId),
              eq(whatsappWakeups.channel_link_id, input.channelLinkId),
              inArray(whatsappWakeups.state, activeStates),
            ),
          )
          .for("update")
          .limit(1);
        if (row === undefined) return null;
        await transaction
          .update(whatsappWakeups)
          .set({ consume_requested_at: now, updated_at: now })
          .where(eq(whatsappWakeups.wakeup_id, row.wakeUpId));
        return WakeUpId.make(row.wakeUpId);
      }),
    );
    if (consumed === null) return null;
    // oxlint-disable-next-line unicorn/no-array-sort -- The Worker target lacks ES2023 toSorted; this array is a fresh copy.
    const pending = [...(yield* sourceAuthority.pendingForUser(input.userId))].sort(compareSources);
    yield* sourceAuthority.exposePending(input.userId, pending);
    yield* attempt("consumeInbound.commit", () =>
      database
        .update(whatsappWakeups)
        .set({
          consumed_at: sql`case when ${whatsappWakeups.state} = 'requested' then null else ${now.toISOString()}::timestamptz end`,
          exposure_completed_at: now,
          lease_expires_at: null,
          lease_id: null,
          safe_failure_class: sql`case when ${whatsappWakeups.state} = 'pending' then 'inboundBeforeSend' else ${whatsappWakeups.safe_failure_class} end`,
          state: sql`case when ${whatsappWakeups.state} = 'requested' then 'requested' else 'consumed' end`,
          updated_at: now,
        })
        .where(
          and(
            eq(whatsappWakeups.wakeup_id, consumed),
            inArray(whatsappWakeups.state, ["pending", "requested", "accepted", "ambiguous"]),
          ),
        ),
    );
    return { pending, wakeUpId: consumed };
  });

  const cancelSource = Effect.fn("WhatsAppWakeUps.cancelSource")(function* (input: {
    readonly source: Source;
    readonly userId: UserId;
  }) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    yield* attempt("cancelSource", () =>
      database.transaction(async (transaction) => {
        const rows = await transaction
          .select({ wakeUpId: whatsappWakeupSources.wakeup_id })
          .from(whatsappWakeupSources)
          .innerJoin(
            whatsappWakeups,
            eq(whatsappWakeups.wakeup_id, whatsappWakeupSources.wakeup_id),
          )
          .where(
            and(
              eq(whatsappWakeups.user_id, input.userId),
              eq(whatsappWakeupSources.source_kind, sourceKindOf(input.source)),
              eq(whatsappWakeupSources.source_identity, input.source.identity),
              inArray(whatsappWakeups.state, activeStates),
            ),
          )
          .for("update");
        if (rows.length === 0) return;
        const wakeUpIds = [...new Set(rows.map(({ wakeUpId }) => wakeUpId))];
        await transaction
          .delete(whatsappWakeupSources)
          .where(
            and(
              inArray(whatsappWakeupSources.wakeup_id, wakeUpIds),
              eq(whatsappWakeupSources.source_kind, sourceKindOf(input.source)),
              eq(whatsappWakeupSources.source_identity, input.source.identity),
            ),
          );
        for (const wakeUpId of wakeUpIds) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Each check observes the association deletion earlier in this same transaction.
          const [remaining] = await transaction
            .select({ requestWakeUpId: whatsappWakeupSources.request_wakeup_id })
            .from(whatsappWakeupSources)
            .where(eq(whatsappWakeupSources.wakeup_id, wakeUpId))
            .limit(1);
          if (remaining !== undefined) continue;
          // oxlint-disable-next-line eslint/no-await-in-loop -- The transaction closes each now-unowned latch deterministically.
          await transaction
            .update(whatsappWakeups)
            .set({
              cancel_requested_at: sql`case when ${whatsappWakeups.state} = 'requested' then ${now.toISOString()}::timestamptz else ${whatsappWakeups.cancel_requested_at} end`,
              canceled_at: sql`case when ${whatsappWakeups.state} = 'requested' then null else ${now.toISOString()}::timestamptz end`,
              lease_expires_at: null,
              lease_id: null,
              safe_failure_class: "sourceCanceled",
              state: sql`case when ${whatsappWakeups.state} = 'requested' then 'requested' else 'canceled' end`,
              updated_at: now,
            })
            .where(
              and(
                eq(whatsappWakeups.wakeup_id, wakeUpId),
                inArray(whatsappWakeups.state, activeStates),
              ),
            );
        }
      }),
    );
  });

  const cancelChannelLink = Effect.fn("WhatsAppWakeUps.cancelChannelLink")(
    (channelLinkId: ChannelLinkId) => cancelChannelLinkRows(database, channelLinkId),
  );

  const deleteUser = Effect.fn("WhatsAppWakeUps.deleteUser")((userId: UserId) =>
    attempt("deleteUser", () =>
      database.delete(whatsappWakeups).where(eq(whatsappWakeups.user_id, userId)),
    ).pipe(Effect.asVoid),
  );

  const loadAuthority = Effect.fn("WhatsAppWakeUps.loadAuthority")(function* (
    userId: UserId,
    channelLinkId: ChannelLinkId,
  ) {
    const rows = yield* attempt("loadAuthority", () =>
      database
        .select({ endpoint: channelLinks.author_id, locale: users.locale })
        .from(channelLinks)
        .innerJoin(users, eq(users.id, channelLinks.user_id))
        .where(
          and(
            eq(channelLinks.channel_link_id, channelLinkId),
            eq(channelLinks.user_id, userId),
            eq(channelLinks.channel_id, "whatsapp"),
            isNull(channelLinks.revoked_at),
            sql`${users.registrationCompletedAt} is not null`,
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (row === undefined || (row.locale !== "en" && row.locale !== "es")) return null;
    return { endpoint: row.endpoint, locale: row.locale };
  });

  const retainAuthorizedSources = Effect.fn("WhatsAppWakeUps.retainAuthorizedSources")(function* (
    userId: UserId,
    wakeUpId: WakeUpId,
  ) {
    const rows = yield* attempt("retainAuthorizedSources.load", () =>
      database
        .select({
          requestWakeUpId: whatsappWakeupSources.request_wakeup_id,
          sourceIdentity: whatsappWakeupSources.source_identity,
          sourceKind: whatsappWakeupSources.source_kind,
        })
        .from(whatsappWakeupSources)
        .where(eq(whatsappWakeupSources.wakeup_id, wakeUpId))
        .orderBy(
          asc(whatsappWakeupSources.source_committed_at),
          asc(whatsappWakeupSources.request_wakeup_id),
        ),
    );
    const inspected = yield* Effect.forEach(rows, (row) =>
      decodeSource(row.sourceKind, row.sourceIdentity).pipe(
        Effect.flatMap((source) =>
          sourceAuthority.inspect(userId, source).pipe(
            Effect.map((committed) => ({
              committed:
                committed !== null && sameSource(committed.source, source) ? committed : null,
              requestWakeUpId: row.requestWakeUpId,
            })),
          ),
        ),
      ),
    );
    const unavailableRequestIds = inspected.flatMap(({ committed, requestWakeUpId }) =>
      committed === null ? [requestWakeUpId] : [],
    );
    if (unavailableRequestIds.length > 0) {
      yield* attempt("retainAuthorizedSources.remove", () =>
        database
          .delete(whatsappWakeupSources)
          .where(inArray(whatsappWakeupSources.request_wakeup_id, unavailableRequestIds)),
      );
    }
    return inspected.flatMap(({ committed }) => (committed === null ? [] : [committed]));
  });

  const reconcileStaleRequested = Effect.fn("WhatsAppWakeUps.reconcileStaleRequested")(function* (
    requestTimeout: Duration.Duration,
  ) {
    const nowDateTime = yield* DateTime.now;
    const now = DateTime.toDateUtc(nowDateTime);
    const cutoff = DateTime.toDateUtc(
      DateTime.subtract(nowDateTime, { milliseconds: Duration.toMillis(requestTimeout) }),
    );
    const recovered = yield* attempt("reconcileStaleRequested", () =>
      database
        .update(whatsappWakeups)
        .set({
          canceled_at: sql`case
            when ${whatsappWakeups.exposure_completed_at} is not null then null
            when ${whatsappWakeups.cancel_requested_at} is not null then ${whatsappWakeups.cancel_requested_at}
            else null
          end`,
          consumed_at: sql`case when ${whatsappWakeups.exposure_completed_at} is null then null else ${whatsappWakeups.exposure_completed_at} end`,
          provider_outcome: "ambiguous",
          safe_failure_class: sql`case
            when ${whatsappWakeups.exposure_completed_at} is not null then 'connectionLost'
            when ${whatsappWakeups.cancel_requested_at} is null then 'connectionLost'
            else ${whatsappWakeups.safe_failure_class}
          end`,
          settled_at: now,
          state: sql`case
            when ${whatsappWakeups.exposure_completed_at} is not null then 'consumed'
            when ${whatsappWakeups.cancel_requested_at} is not null then 'canceled'
            else 'ambiguous'
          end`,
          updated_at: now,
        })
        .where(
          and(eq(whatsappWakeups.state, "requested"), lt(whatsappWakeups.requested_at, cutoff)),
        )
        .returning({ state: whatsappWakeups.state, wakeUpId: whatsappWakeups.wakeup_id }),
    );
    return recovered.reduce(
      (counts, row) => ({
        ambiguous: counts.ambiguous + (row.state === "ambiguous" ? 1 : 0),
        canceled: counts.canceled + (row.state === "canceled" ? 1 : 0),
      }),
      { ambiguous: 0, canceled: 0 },
    );
  });

  const claimPending = Effect.fn("WhatsAppWakeUps.claimPending")(function* (
    leaseDuration: Duration.Duration,
  ) {
    const nowDateTime = yield* DateTime.now;
    const now = DateTime.toDateUtc(nowDateTime);
    const leaseExpiresAt = DateTime.toDateUtc(
      DateTime.add(nowDateTime, { milliseconds: Duration.toMillis(leaseDuration) }),
    );
    const leaseId = `whatsapp-wakeup-lease-${yield* crypto.randomUUIDv7.pipe(
      Effect.mapError(
        (cause) => new WakeUpUnavailable({ cause, operation: "claimPending.identity" }),
      ),
    )}`;
    return yield* attempt("claimPending", () =>
      database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({
            channelLinkId: whatsappWakeups.channel_link_id,
            endpointFingerprint: whatsappWakeups.endpoint_fingerprint,
            locale: whatsappWakeups.locale,
            sourceIdentity: whatsappWakeups.source_identity,
            sourceKind: whatsappWakeups.source_kind,
            traceId: whatsappWakeups.trace_id,
            userId: whatsappWakeups.user_id,
            wakeUpId: whatsappWakeups.wakeup_id,
          })
          .from(whatsappWakeups)
          .where(
            and(
              eq(whatsappWakeups.state, "pending"),
              isNull(whatsappWakeups.consume_requested_at),
              or(
                isNull(whatsappWakeups.lease_expires_at),
                lt(whatsappWakeups.lease_expires_at, now),
              ),
            ),
          )
          .orderBy(asc(whatsappWakeups.created_at), asc(whatsappWakeups.wakeup_id))
          .for("update", { skipLocked: true })
          .limit(1);
        if (row === undefined) return null;
        await transaction
          .update(whatsappWakeups)
          .set({ lease_expires_at: leaseExpiresAt, lease_id: leaseId, updated_at: now })
          .where(eq(whatsappWakeups.wakeup_id, row.wakeUpId));
        const locale = row.locale;
        if (locale !== "en" && locale !== "es") return null;
        return {
          channelLinkId: ChannelLinkId.make(row.channelLinkId),
          endpointFingerprint: row.endpointFingerprint,
          leaseId,
          locale,
          sourceIdentity: SourceIdentity.make(row.sourceIdentity),
          sourceKind: row.sourceKind,
          traceId: row.traceId,
          userId: UserId.make(row.userId),
          wakeUpId: WakeUpId.make(row.wakeUpId),
        };
      }),
    );
  });

  const cancelClaim = Effect.fn("WhatsAppWakeUps.cancelClaim")(function* (
    wakeUpId: WakeUpId,
    leaseId: string,
    userId: UserId,
    failureClass: "authorityLost" | "sourceCanceled",
  ) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    return yield* attempt("cancelClaim", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
        );
        if (failureClass === "sourceCanceled") {
          const [attached] = await transaction
            .select({ requestWakeUpId: whatsappWakeupSources.request_wakeup_id })
            .from(whatsappWakeupSources)
            .where(eq(whatsappWakeupSources.wakeup_id, wakeUpId))
            .limit(1);
          if (attached !== undefined) {
            await transaction
              .update(whatsappWakeups)
              .set({ lease_expires_at: null, lease_id: null, updated_at: now })
              .where(
                and(
                  eq(whatsappWakeups.wakeup_id, wakeUpId),
                  eq(whatsappWakeups.state, "pending"),
                  eq(whatsappWakeups.lease_id, leaseId),
                ),
              );
            return false;
          }
        }
        const canceled = await transaction
          .update(whatsappWakeups)
          .set({
            canceled_at: now,
            lease_expires_at: null,
            lease_id: null,
            safe_failure_class: failureClass,
            state: "canceled",
            updated_at: now,
          })
          .where(
            and(
              eq(whatsappWakeups.wakeup_id, wakeUpId),
              eq(whatsappWakeups.state, "pending"),
              eq(whatsappWakeups.lease_id, leaseId),
            ),
          )
          .returning({ wakeUpId: whatsappWakeups.wakeup_id });
        return canceled.length === 1;
      }),
    );
  });

  const markRequested = Effect.fn("WhatsAppWakeUps.markRequested")(function* (claim: {
    readonly channelLinkId: ChannelLinkId;
    readonly leaseId: string;
    readonly locale: Locale;
    readonly userId: UserId;
    readonly wakeUpId: WakeUpId;
  }) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    return yield* attempt("markRequested", () =>
      database.transaction(async (transaction) => {
        const [user] = await transaction
          .select({ locale: users.locale, registrationCompletedAt: users.registrationCompletedAt })
          .from(users)
          .where(eq(users.id, claim.userId))
          .for("update")
          .limit(1);
        const [link] = await transaction
          .select({ revokedAt: channelLinks.revoked_at, userId: channelLinks.user_id })
          .from(channelLinks)
          .where(eq(channelLinks.channel_link_id, claim.channelLinkId))
          .for("update")
          .limit(1);
        const [deletionCase] = await transaction
          .select({ id: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(eq(deletionCases.user_id, claim.userId))
          .limit(1);
        const [suspension] = await transaction
          .select({ action: userSuspensionEvents.action })
          .from(userSuspensionEvents)
          .where(eq(userSuspensionEvents.user_id, claim.userId))
          .orderBy(desc(userSuspensionEvents.occurred_at), desc(userSuspensionEvents.event_id))
          .limit(1);
        const [row] = await transaction
          .select({ wakeUpId: whatsappWakeups.wakeup_id })
          .from(whatsappWakeups)
          .where(
            and(
              eq(whatsappWakeups.wakeup_id, claim.wakeUpId),
              eq(whatsappWakeups.state, "pending"),
              eq(whatsappWakeups.lease_id, claim.leaseId),
              isNull(whatsappWakeups.consume_requested_at),
            ),
          )
          .for("update")
          .limit(1);
        if (row === undefined) return "lost" as const;
        if (
          user === undefined ||
          user.registrationCompletedAt === null ||
          user.locale !== claim.locale ||
          link === undefined ||
          link.userId !== claim.userId ||
          link.revokedAt !== null ||
          deletionCase !== undefined ||
          suspension?.action === "suspended"
        ) {
          await transaction
            .update(whatsappWakeups)
            .set({
              canceled_at: now,
              lease_expires_at: null,
              lease_id: null,
              safe_failure_class: "authorityLost",
              state: "canceled",
              updated_at: now,
            })
            .where(eq(whatsappWakeups.wakeup_id, claim.wakeUpId));
          return "canceled" as const;
        }
        await transaction
          .update(whatsappWakeups)
          .set({
            lease_expires_at: null,
            lease_id: null,
            requested_at: now,
            state: "requested",
            updated_at: now,
          })
          .where(eq(whatsappWakeups.wakeup_id, claim.wakeUpId));
        return "requested" as const;
      }),
    );
  });

  const settle = Effect.fn("WhatsAppWakeUps.settle")(function* (
    wakeUpId: WakeUpId,
    outcome:
      | { readonly _tag: "accepted"; readonly providerMessageId: string }
      | {
          readonly _tag: "ambiguous";
          readonly failureClass: "providerTimeout" | "connectionLost" | "malformedSuccess";
        }
      | { readonly _tag: "rejected"; readonly failureClass: "providerRejected" },
    providerMessageIdHash: string | null,
  ) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    yield* attempt("settle", () =>
      database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({
            cancelRequestedAt: whatsappWakeups.cancel_requested_at,
            exposureCompletedAt: whatsappWakeups.exposure_completed_at,
          })
          .from(whatsappWakeups)
          .where(
            and(eq(whatsappWakeups.wakeup_id, wakeUpId), eq(whatsappWakeups.state, "requested")),
          )
          .for("update")
          .limit(1);
        if (row === undefined) return;
        const consumed = row.exposureCompletedAt !== null;
        const canceled = !consumed && row.cancelRequestedAt !== null;
        await transaction
          .update(whatsappWakeups)
          .set({
            canceled_at: canceled ? row.cancelRequestedAt : null,
            consumed_at: consumed ? row.exposureCompletedAt : null,
            provider_message_id_hash: providerMessageIdHash,
            provider_outcome: outcome._tag,
            safe_failure_class: outcome._tag === "accepted" ? null : outcome.failureClass,
            settled_at: now,
            state: consumed ? "consumed" : canceled ? "canceled" : outcome._tag,
            updated_at: now,
          })
          .where(eq(whatsappWakeups.wakeup_id, wakeUpId));
      }),
    );
  });

  return Service.of({
    cancelChannelLink,
    cancelSource,
    consumeInbound,
    deleteUser,
    drainPending,
    request,
  });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

/** Empty source adapter keeps production inert until source owners compose their facts. */
export const emptySourceAuthorityLayer = Layer.succeed(
  SourceAuthority,
  SourceAuthority.of({
    exposePending: () => Effect.void,
    inspect: () => Effect.succeed(null),
    pendingForUser: () => Effect.succeed([]),
  }),
);

export const cancelChannelLinkRows = (database: Db.Database, channelLinkId: ChannelLinkId) =>
  Effect.gen(function* () {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    yield* attempt("cancelChannelLink", () =>
      database
        .update(whatsappWakeups)
        .set({
          cancel_requested_at: sql`case when ${whatsappWakeups.state} = 'requested' then ${now.toISOString()}::timestamptz else ${whatsappWakeups.cancel_requested_at} end`,
          canceled_at: sql`case when ${whatsappWakeups.state} = 'requested' then null else ${now.toISOString()}::timestamptz end`,
          lease_expires_at: null,
          lease_id: null,
          safe_failure_class: "authorityLost",
          state: sql`case when ${whatsappWakeups.state} = 'requested' then 'requested' else 'canceled' end`,
          updated_at: now,
        })
        .where(
          and(
            eq(whatsappWakeups.channel_link_id, channelLinkId),
            or(
              eq(whatsappWakeups.state, "pending"),
              eq(whatsappWakeups.state, "requested"),
              eq(whatsappWakeups.state, "accepted"),
              eq(whatsappWakeups.state, "ambiguous"),
            ),
          ),
        ),
    );
  });

/** Delete only after every provider request that durably started has reached a closed outcome. */
export const deleteUserRowsBeforeAgentTeardown = (
  database: Db.Database,
  userId: UserId,
): Promise<boolean> =>
  database.transaction(async (transaction) => {
    const [user] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")
      .limit(1);
    if (user === undefined) return true;
    const [inFlight] = await transaction
      .select({ wakeUpId: whatsappWakeups.wakeup_id })
      .from(whatsappWakeups)
      .where(and(eq(whatsappWakeups.user_id, userId), eq(whatsappWakeups.state, "requested")))
      .for("update")
      .limit(1);
    if (inFlight !== undefined) return false;
    await transaction.delete(whatsappWakeups).where(eq(whatsappWakeups.user_id, userId));
    return true;
  });

const attempt = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WakeUpUnavailable({ cause, operation }),
  });

const unavailable = (operation: string, cause: unknown) =>
  new WakeUpUnavailable({ cause, operation });

const digest = (crypto: Crypto.Crypto, value: string, operation: string) =>
  crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
    Effect.map(Encoding.encodeHex),
    Effect.mapError((cause) => unavailable(operation, cause)),
  );

const decodeEndpoint = (value: string, operation: string) =>
  Schema.decodeEffect(EndpointIdentity)(value).pipe(
    Effect.mapError((cause) => unavailable(operation, cause)),
  );

const sourceKindOf = (source: Source) => {
  switch (source._tag) {
    case "Reminder":
      return "reminder" as const;
    case "ResearchReport":
      return "researchReport" as const;
    case "DocumentBuild":
      return "documentBuild" as const;
    case "ScheduledEmail":
      return "scheduledEmail" as const;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
};

const decodeSource = (
  kind: string,
  encodedIdentity: string,
): Effect.Effect<Source, WakeUpUnavailable> =>
  Effect.gen(function* () {
    const identity = yield* Schema.decodeEffect(SourceIdentity)(encodedIdentity).pipe(
      Effect.mapError((cause) => unavailable("drain.sourceIdentity", cause)),
    );
    switch (kind) {
      case "reminder":
        return Source.cases.Reminder.make({ identity });
      case "researchReport":
        return Source.cases.ResearchReport.make({ identity });
      case "documentBuild":
        return Source.cases.DocumentBuild.make({ identity });
      case "scheduledEmail":
        return Source.cases.ScheduledEmail.make({ identity });
      default:
        return yield* unavailable("drain.sourceKind", kind);
    }
  });

const encodeSource = (source: Source) => ({
  kind: sourceKindOf(source),
  identity: source.identity,
});

const sameSource = (left: Source, right: Source) =>
  left._tag === right._tag && left.identity === right.identity;

const compareSources = (left: CommittedSource, right: CommittedSource) => {
  const committed = left.committedAt.getTime() - right.committedAt.getTime();
  if (committed !== 0) return committed;
  const kind = sourceKindOf(left.source).localeCompare(sourceKindOf(right.source));
  return kind !== 0 ? kind : left.source.identity.localeCompare(right.source.identity);
};

export * as WhatsAppWakeUps from "./whatsapp-wakeups";

const FingerprintJson = Schema.fromJsonString(
  Schema.Struct({
    channelLinkId: Schema.String,
    endpointFingerprint: Schema.String,
    locale: Locale,
    source: Schema.Struct({ identity: Schema.String, kind: Schema.String }),
    templatePolicyVersion: Schema.Literal(templatePolicyVersion),
    userId: Schema.String,
  }),
);
