import { users } from "@osfo/db/schema/auth";
import { channelLinks } from "@osfo/db/schema/channel-links";
import { whatsappWakeups } from "@osfo/db/schema/whatsapp-wakeups";
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
          .select({ fingerprint: whatsappWakeups.fingerprint })
          .from(whatsappWakeups)
          .where(eq(whatsappWakeups.wakeup_id, input.wakeUpId))
          .limit(1);
        if (exact !== undefined) {
          return exact.fingerprint === fingerprint
            ? { _tag: "Replayed" as const }
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
        return { _tag: "Created" as const };
      }),
    );
    if (result._tag === "Conflict") return yield* new WakeUpConflict({ wakeUpId: input.wakeUpId });
    if (result._tag === "Unavailable") {
      return yield* unavailable("request.recheck", input.channelLinkId);
    }
    return result._tag === "Coalesced"
      ? { _tag: result._tag, wakeUpId: WakeUpId.make(result.wakeUpId) }
      : { _tag: result._tag, wakeUpId: input.wakeUpId };
  });

  const drainPending = Effect.fn("WhatsAppWakeUps.drainPending")(function* (
    options: { readonly leaseDuration?: Duration.Input; readonly limit?: number } = {},
  ) {
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const leaseDuration = Duration.fromInputUnsafe(options.leaseDuration ?? { minutes: 2 });
    const counts = { accepted: 0, ambiguous: 0, canceled: 0, rejected: 0 };
    for (let index = 0; index < limit; index += 1) {
      const claim = yield* claimPending(leaseDuration);
      if (claim === null) break;
      const source = yield* decodeSource(claim.sourceKind, claim.sourceIdentity);
      const committed = yield* sourceAuthority.inspect(claim.userId, source);
      if (committed === null) {
        yield* cancelClaim(claim.wakeUpId, claim.leaseId, "sourceCanceled");
        counts.canceled += 1;
        continue;
      }
      const authority = yield* loadAuthority(claim.userId, claim.channelLinkId);
      if (authority === null || authority.locale !== claim.locale) {
        yield* cancelClaim(claim.wakeUpId, claim.leaseId, "authorityLost");
        counts.canceled += 1;
        continue;
      }
      const locale = yield* Schema.decodeUnknownEffect(Locale)(claim.locale).pipe(
        Effect.mapError((cause) => unavailable("drain.locale", cause)),
      );
      const endpoint = yield* decodeEndpoint(authority.endpoint, "drain.endpoint");
      const endpointFingerprint = yield* digest(crypto, endpoint, "drain.endpointFingerprint");
      if (endpointFingerprint !== claim.endpointFingerprint) {
        yield* cancelClaim(claim.wakeUpId, claim.leaseId, "authorityLost");
        counts.canceled += 1;
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
        if (row.state === "requested") {
          await transaction
            .update(whatsappWakeups)
            .set({ consume_requested_at: now, updated_at: now })
            .where(eq(whatsappWakeups.wakeup_id, row.wakeUpId));
        } else {
          await transaction
            .update(whatsappWakeups)
            .set({
              consumed_at: now,
              lease_expires_at: null,
              lease_id: null,
              safe_failure_class: row.state === "pending" ? "inboundBeforeSend" : null,
              state: "consumed",
              updated_at: now,
            })
            .where(eq(whatsappWakeups.wakeup_id, row.wakeUpId));
        }
        return WakeUpId.make(row.wakeUpId);
      }),
    );
    if (consumed === null) return null;
    // oxlint-disable-next-line unicorn/no-array-sort -- The Worker target lacks ES2023 toSorted; this array is a fresh copy.
    const pending = [...(yield* sourceAuthority.pendingForUser(input.userId))].sort(compareSources);
    yield* sourceAuthority.exposePending(input.userId, pending);
    return { pending, wakeUpId: consumed };
  });

  const cancelSource = Effect.fn("WhatsAppWakeUps.cancelSource")(function* (input: {
    readonly source: Source;
    readonly userId: UserId;
  }) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    yield* attempt("cancelSource", () =>
      database
        .update(whatsappWakeups)
        .set({
          canceled_at: now,
          lease_expires_at: null,
          lease_id: null,
          safe_failure_class: "sourceCanceled",
          state: "canceled",
          updated_at: now,
        })
        .where(
          and(
            eq(whatsappWakeups.user_id, input.userId),
            eq(whatsappWakeups.source_kind, sourceKindOf(input.source)),
            eq(whatsappWakeups.source_identity, input.source.identity),
            or(
              eq(whatsappWakeups.state, "pending"),
              eq(whatsappWakeups.state, "accepted"),
              eq(whatsappWakeups.state, "ambiguous"),
            ),
          ),
        ),
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
    failureClass: "authorityLost" | "sourceCanceled",
  ) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    yield* attempt("cancelClaim", () =>
      database
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
        ),
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
          .select({ consumeRequestedAt: whatsappWakeups.consume_requested_at })
          .from(whatsappWakeups)
          .where(
            and(eq(whatsappWakeups.wakeup_id, wakeUpId), eq(whatsappWakeups.state, "requested")),
          )
          .for("update")
          .limit(1);
        if (row === undefined) return;
        const consumed = row.consumeRequestedAt !== null && outcome._tag !== "rejected";
        await transaction
          .update(whatsappWakeups)
          .set({
            consumed_at: consumed ? row.consumeRequestedAt : null,
            provider_message_id_hash: providerMessageIdHash,
            provider_outcome: outcome._tag,
            safe_failure_class: outcome._tag === "accepted" ? null : outcome.failureClass,
            settled_at: now,
            state: consumed ? "consumed" : outcome._tag,
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
          canceled_at: now,
          lease_expires_at: null,
          lease_id: null,
          safe_failure_class: "authorityLost",
          state: "canceled",
          updated_at: now,
        })
        .where(
          and(
            eq(whatsappWakeups.channel_link_id, channelLinkId),
            or(
              eq(whatsappWakeups.state, "pending"),
              eq(whatsappWakeups.state, "accepted"),
              eq(whatsappWakeups.state, "ambiguous"),
            ),
          ),
        ),
    );
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
  identity: SourceIdentity,
): Effect.Effect<Source, WakeUpUnavailable> => {
  switch (kind) {
    case "reminder":
      return Effect.succeed(Source.cases.Reminder.make({ identity }));
    case "researchReport":
      return Effect.succeed(Source.cases.ResearchReport.make({ identity }));
    case "documentBuild":
      return Effect.succeed(Source.cases.DocumentBuild.make({ identity }));
    case "scheduledEmail":
      return Effect.succeed(Source.cases.ScheduledEmail.make({ identity }));
    default:
      return Effect.fail(unavailable("drain.sourceKind", kind));
  }
};

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
