import { BrowserCrypto } from "@effect/platform-browser";
import type { Database } from "@osfo/db";
import { allowanceUsage } from "@osfo/db/schema/allowances";
import { whatsappWakeups, whatsappWakeupSources } from "@osfo/db/schema/whatsapp-wakeups";
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber, Latch, Layer, Redacted, Ref, Schema } from "effect";
import postgres, { type Sql } from "postgres";

import { loadConfig } from "../../src/config";
import { AccountDeletionComposition } from "../../src/composition/account-deletion";
import { Db } from "../../src/db";
import { AgentId, UserId } from "../../src/domain";
import { AccountDeletion } from "../../src/services/account-deletion";
import { ChannelLinks } from "../../src/services/channel-links";
import { WhatsAppWakeUps } from "../../src/services/whatsapp-wakeups";
import { spawnApp } from "../support/spawn-app";

/* oxlint-disable effecttsgo/strict-effect-provide, effecttsgo/global-date-in-effect, effecttsgo/async-function, effecttsgo/run-effect-inside-effect, eslint/no-underscore-dangle -- This test owns the real PostgreSQL authority composition and its external Promise boundaries. */

it.effect(
  "replays exact requests, rejects changed identity, and coalesces later committed work",
  () =>
    withFixture(({ calls, link, sources, userId, wakeUps }) =>
      Effect.gen(function* () {
        const reminder = WhatsAppWakeUps.Source.cases.Reminder.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("reminder-1"),
        });
        const report = WhatsAppWakeUps.Source.cases.ResearchReport.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("report-1"),
        });
        yield* Ref.set(sources, [
          { committedAt: new Date("2026-08-27T12:00:00.000Z"), source: reminder },
          { committedAt: new Date("2026-08-27T12:01:00.000Z"), source: report },
        ]);
        const input = {
          channelLinkId: link.channelLinkId,
          source: reminder,
          traceId: WhatsAppWakeUps.TraceId.make("trace-1"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-1"),
        };
        expect(yield* wakeUps.request(input)).toEqual({ _tag: "Created", wakeUpId: "wakeup-1" });
        expect(
          yield* wakeUps.request({
            ...input,
            traceId: WhatsAppWakeUps.TraceId.make("trace-replay"),
          }),
        ).toEqual({
          _tag: "Replayed",
          wakeUpId: "wakeup-1",
        });
        expect(
          yield* wakeUps.request({ ...input, source: report }).pipe(
            Effect.flip,
            Effect.map((failure) => failure._tag),
          ),
        ).toBe("WhatsAppWakeUpConflict");
        expect(
          yield* wakeUps.request({
            ...input,
            source: report,
            wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-2"),
          }),
        ).toEqual({ _tag: "Coalesced", wakeUpId: "wakeup-1" });
        expect(
          yield* wakeUps.request({
            ...input,
            source: report,
            traceId: WhatsAppWakeUps.TraceId.make("trace-coalesced-replay"),
            wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-2"),
          }),
        ).toEqual({ _tag: "Replayed", wakeUpId: "wakeup-1" });
        yield* wakeUps.cancelSource({ source: reminder, userId });
        expect((yield* wakeUps.drainPending()).accepted).toBe(1);
        expect((yield* Ref.get(calls)).length).toBe(1);
      }),
    ),
);

it.effect(
  "records one accepted template, blocks resend, and exposes committed results in order",
  () =>
    withFixture(({ calls, database, endpoint, exposedSources, link, sources, userId, wakeUps }) =>
      Effect.gen(function* () {
        const reminder = WhatsAppWakeUps.Source.cases.Reminder.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("reminder-late"),
        });
        const document = WhatsAppWakeUps.Source.cases.DocumentBuild.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("document-early"),
        });
        yield* Ref.set(sources, [
          { committedAt: new Date("2026-08-27T12:02:00.000Z"), source: reminder },
          { committedAt: new Date("2026-08-27T12:01:00.000Z"), source: document },
        ]);
        yield* wakeUps.request({
          channelLinkId: link.channelLinkId,
          source: reminder,
          traceId: WhatsAppWakeUps.TraceId.make("trace-accepted"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-accepted"),
        });
        const usageBefore = yield* Effect.promise(() =>
          database.select().from(allowanceUsage).where(eq(allowanceUsage.user_id, userId)),
        );

        expect(yield* wakeUps.drainPending()).toEqual({
          accepted: 1,
          ambiguous: 0,
          canceled: 0,
          rejected: 0,
        });
        expect(yield* wakeUps.drainPending()).toEqual({
          accepted: 0,
          ambiguous: 0,
          canceled: 0,
          rejected: 0,
        });
        expect(yield* Ref.get(calls)).toEqual([{ endpoint, locale: "en" }]);
        expect(
          yield* Effect.promise(() =>
            database.select().from(allowanceUsage).where(eq(allowanceUsage.user_id, userId)),
          ),
        ).toEqual(usageBefore);
        const consumed = yield* wakeUps.consumeInbound({
          channelLinkId: link.channelLinkId,
          userId,
        });
        expect(consumed?.pending.map(({ source }) => source.identity)).toEqual([
          "document-early",
          "reminder-late",
        ]);
        expect((yield* Ref.get(exposedSources)).map(({ source }) => source.identity)).toEqual([
          "document-early",
          "reminder-late",
        ]);
        expect(
          yield* wakeUps.consumeInbound({ channelLinkId: link.channelLinkId, userId }),
        ).toBeNull();
      }),
    ),
);

it.effect("removes a source when its owner returns a different committed identity", () =>
  withFixture(({ calls, inspectionOverride, link, sources, userId, wakeUps }) =>
    Effect.gen(function* () {
      const requested = WhatsAppWakeUps.Source.cases.Reminder.make({
        identity: WhatsAppWakeUps.SourceIdentity.make("reminder-requested"),
      });
      const mismatched = WhatsAppWakeUps.Source.cases.Reminder.make({
        identity: WhatsAppWakeUps.SourceIdentity.make("reminder-other"),
      });
      yield* Ref.set(sources, [
        { committedAt: new Date("2026-08-27T12:00:00.000Z"), source: requested },
      ]);
      yield* wakeUps.request({
        channelLinkId: link.channelLinkId,
        source: requested,
        traceId: WhatsAppWakeUps.TraceId.make("trace-source-mismatch"),
        userId,
        wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-source-mismatch"),
      });
      yield* Ref.set(inspectionOverride, {
        committedAt: new Date("2026-08-27T12:00:00.000Z"),
        source: mismatched,
      });
      expect(yield* wakeUps.drainPending()).toEqual({
        accepted: 0,
        ambiguous: 0,
        canceled: 1,
        rejected: 0,
      });
      expect(yield* Ref.get(calls)).toEqual([]);
    }),
  ),
);

it.effect("retries owner exposure when it fails before consumption commits", () =>
  withFixture(({ failExposure, link, sources, userId, wakeUps }) =>
    Effect.gen(function* () {
      const source = WhatsAppWakeUps.Source.cases.DocumentBuild.make({
        identity: WhatsAppWakeUps.SourceIdentity.make("document-exposure-retry"),
      });
      yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
      yield* wakeUps.request({
        channelLinkId: link.channelLinkId,
        source,
        traceId: WhatsAppWakeUps.TraceId.make("trace-exposure-retry"),
        userId,
        wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-exposure-retry"),
      });
      yield* Ref.set(failExposure, true);
      expect(
        yield* wakeUps.consumeInbound({ channelLinkId: link.channelLinkId, userId }).pipe(
          Effect.flip,
          Effect.map((failure) => failure._tag),
        ),
      ).toBe("WhatsAppWakeUpUnavailable");
      yield* Ref.set(failExposure, false);
      expect(
        (yield* wakeUps.consumeInbound({ channelLinkId: link.channelLinkId, userId }))?.pending.map(
          ({ source: pendingSource }) => pendingSource.identity,
        ),
      ).toEqual(["document-exposure-retry"]);
    }),
  ),
);

it.effect("keeps a provider-racing latch active until owner exposure succeeds", () =>
  withFixture(
    ({
      blockSender,
      database,
      failExposure,
      link,
      senderRelease,
      senderStarted,
      sources,
      userId,
      wakeUps,
    }) =>
      Effect.gen(function* () {
        const source = WhatsAppWakeUps.Source.cases.DocumentBuild.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("document-racing-exposure"),
        });
        yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
        yield* Ref.set(blockSender, true);
        yield* wakeUps.request({
          channelLinkId: link.channelLinkId,
          source,
          traceId: WhatsAppWakeUps.TraceId.make("trace-racing-exposure"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-racing-exposure"),
        });
        const drain = yield* wakeUps.drainPending().pipe(Effect.forkChild);
        yield* Deferred.await(senderStarted);
        yield* Ref.set(failExposure, true);
        expect(
          yield* wakeUps.consumeInbound({ channelLinkId: link.channelLinkId, userId }).pipe(
            Effect.flip,
            Effect.map((failure) => failure._tag),
          ),
        ).toBe("WhatsAppWakeUpUnavailable");
        yield* Deferred.succeed(senderRelease, undefined);
        yield* Fiber.join(drain);
        const [beforeRetry] = yield* Effect.promise(() =>
          database
            .select({
              exposureCompletedAt: whatsappWakeups.exposure_completed_at,
              state: whatsappWakeups.state,
            })
            .from(whatsappWakeups)
            .where(eq(whatsappWakeups.wakeup_id, "wakeup-racing-exposure")),
        );
        expect(beforeRetry).toEqual({ exposureCompletedAt: null, state: "accepted" });
        yield* Ref.set(failExposure, false);
        expect(
          (yield* wakeUps.consumeInbound({ channelLinkId: link.channelLinkId, userId }))?.pending,
        ).toEqual([{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
        const [afterRetry] = yield* Effect.promise(() =>
          database
            .select({
              exposureCompletedAt: whatsappWakeups.exposure_completed_at,
              state: whatsappWakeups.state,
            })
            .from(whatsappWakeups)
            .where(eq(whatsappWakeups.wakeup_id, "wakeup-racing-exposure")),
        );
        expect(afterRetry?.state).toBe("consumed");
        expect(afterRetry?.exposureCompletedAt).toBeInstanceOf(Date);
      }),
  ),
);

it.effect("serializes concurrent inbound exposure behind the User fence", () =>
  withFixture(
    ({
      blockExposure,
      exposedSources,
      exposureRelease,
      exposureStarted,
      link,
      sources,
      userId,
      wakeUps,
    }) =>
      Effect.gen(function* () {
        const source = WhatsAppWakeUps.Source.cases.DocumentBuild.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("document-concurrent-inbound"),
        });
        const committed = { committedAt: new Date("2026-08-27T12:00:00.000Z"), source };
        yield* Ref.set(sources, [committed]);
        yield* Ref.set(blockExposure, true);
        yield* wakeUps.request({
          channelLinkId: link.channelLinkId,
          source,
          traceId: WhatsAppWakeUps.TraceId.make("trace-concurrent-inbound"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-concurrent-inbound"),
        });
        const [firstResult, secondResult] = yield* Effect.acquireUseRelease(
          Effect.sync(() => postgres(env.DB.connectionString, { max: 1, prepare: false })),
          (lockObserver) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => lockObserver`select 1`);
              const first = yield* wakeUps
                .consumeInbound({ channelLinkId: link.channelLinkId, userId })
                .pipe(Effect.forkChild);
              yield* Deferred.await(exposureStarted);
              const second = yield* wakeUps
                .consumeInbound({ channelLinkId: link.channelLinkId, userId })
                .pipe(Effect.forkChild);
              yield* awaitPostgresLockWaiters(lockObserver, 1);
              yield* Deferred.succeed(exposureRelease, undefined);
              return [yield* Fiber.join(first), yield* Fiber.join(second)] as const;
            }).pipe(Effect.ensuring(Deferred.succeed(exposureRelease, undefined))),
          (lockObserver) => Effect.promise(() => lockObserver.end()),
        );
        expect(firstResult).toEqual({
          pending: [committed],
          wakeUpId: "wakeup-concurrent-inbound",
        });
        expect(secondResult).toBeNull();
        expect(yield* Ref.get(exposedSources)).toEqual([committed]);
      }),
  ),
);

it.effect("does not cancel a newly coalesced source from a stale empty-source snapshot", () =>
  withFixture(
    ({
      calls,
      inspectionGateIdentity,
      inspectionRelease,
      inspectionStarted,
      link,
      sources,
      userId,
      wakeUps,
    }) =>
      Effect.gen(function* () {
        const first = WhatsAppWakeUps.Source.cases.Reminder.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("reminder-revoked-before-cancel"),
        });
        const later = WhatsAppWakeUps.Source.cases.ScheduledEmail.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("email-coalesced-during-cancel"),
        });
        yield* Ref.set(sources, [
          { committedAt: new Date("2026-08-27T12:00:00.000Z"), source: first },
        ]);
        yield* wakeUps.request({
          channelLinkId: link.channelLinkId,
          source: first,
          traceId: WhatsAppWakeUps.TraceId.make("trace-first-before-cancel"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-first-before-cancel"),
        });
        yield* Ref.set(sources, [
          { committedAt: new Date("2026-08-27T12:01:00.000Z"), source: later },
        ]);
        yield* Ref.set(inspectionGateIdentity, first.identity);
        const drain = yield* wakeUps.drainPending().pipe(Effect.forkChild);
        yield* Deferred.await(inspectionStarted);
        expect(
          yield* wakeUps.request({
            channelLinkId: link.channelLinkId,
            source: later,
            traceId: WhatsAppWakeUps.TraceId.make("trace-later-during-cancel"),
            userId,
            wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-later-during-cancel"),
          }),
        ).toEqual({ _tag: "Coalesced", wakeUpId: "wakeup-first-before-cancel" });
        yield* Deferred.succeed(inspectionRelease, undefined);
        expect(yield* Fiber.join(drain)).toEqual({
          accepted: 1,
          ambiguous: 0,
          canceled: 0,
          rejected: 0,
        });
        expect((yield* Ref.get(calls)).length).toBe(1);
      }),
  ),
);

it.effect("waits for the User serialization fence before direct source cancellation", () =>
  withFixture(({ database, link, sources, userId, wakeUps }) =>
    Effect.gen(function* () {
      const source = WhatsAppWakeUps.Source.cases.Reminder.make({
        identity: WhatsAppWakeUps.SourceIdentity.make("reminder-direct-cancel-race"),
      });
      yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
      yield* wakeUps.request({
        channelLinkId: link.channelLinkId,
        source,
        traceId: WhatsAppWakeUps.TraceId.make("trace-direct-cancel-first"),
        userId,
        wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-direct-cancel-first"),
      });
      const fenceReady = Latch.makeUnsafe();
      const fenceRelease = Latch.makeUnsafe();
      yield* Effect.acquireUseRelease(
        Effect.sync(() => ({
          blockerClient: postgres(env.DB.connectionString, { max: 1, prepare: false }),
          lockObserver: postgres(env.DB.connectionString, { max: 1, prepare: false }),
        })),
        ({ blockerClient, lockObserver }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Promise.all([lockObserver`select 1`, blockerClient`select 1`]),
            );
            const fence = yield* Effect.forkChild(
              Effect.promise(() =>
                blockerClient.begin(async (transaction) => {
                  await transaction`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
                  fenceReady.openUnsafe();
                  await Effect.runPromise(fenceRelease.await);
                }),
              ),
            );
            yield* fenceReady.await.pipe(Effect.timeout("5 seconds"));
            const cancellation = yield* Effect.forkChild(wakeUps.cancelSource({ source, userId }));
            yield* awaitPostgresLockWaiters(lockObserver, 1);
            expect(cancellation.pollUnsafe()).toBeUndefined();
            yield* fenceRelease.open;
            yield* Fiber.join(fence);
            yield* Fiber.join(cancellation);
          }).pipe(Effect.ensuring(fenceRelease.open)),
        ({ blockerClient, lockObserver }) =>
          Effect.promise(() => Promise.all([blockerClient.end(), lockObserver.end()])),
      );
      const [afterRelease] = yield* Effect.promise(() =>
        database
          .select({ state: whatsappWakeups.state })
          .from(whatsappWakeups)
          .where(eq(whatsappWakeups.wakeup_id, "wakeup-direct-cancel-first")),
      );
      expect(afterRelease?.state).toBe("canceled");
    }),
  ),
);

it.effect("starts a replacement latch after an in-flight reply snapshot is committed", () =>
  withFixture(
    ({
      blockSender,
      calls,
      database,
      link,
      senderRelease,
      senderStarted,
      sources,
      userId,
      wakeUps,
    }) =>
      Effect.gen(function* () {
        const first = WhatsAppWakeUps.Source.cases.Reminder.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("reminder-before-inbound"),
        });
        const later = WhatsAppWakeUps.Source.cases.DocumentBuild.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("document-after-inbound-snapshot"),
        });
        yield* Ref.set(sources, [
          { committedAt: new Date("2026-08-27T12:00:00.000Z"), source: first },
        ]);
        yield* Ref.set(blockSender, true);
        yield* wakeUps.request({
          channelLinkId: link.channelLinkId,
          source: first,
          traceId: WhatsAppWakeUps.TraceId.make("trace-before-inbound"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-before-inbound"),
        });
        const firstDrain = yield* wakeUps.drainPending().pipe(Effect.forkChild);
        yield* Deferred.await(senderStarted);
        expect(
          (yield* wakeUps.consumeInbound({
            channelLinkId: link.channelLinkId,
            userId,
          }))?.pending.map(({ source }) => source.identity),
        ).toEqual(["reminder-before-inbound"]);
        yield* Ref.set(sources, [
          { committedAt: new Date("2026-08-27T12:01:00.000Z"), source: later },
        ]);
        expect(
          yield* wakeUps.request({
            channelLinkId: link.channelLinkId,
            source: later,
            traceId: WhatsAppWakeUps.TraceId.make("trace-after-inbound-snapshot"),
            userId,
            wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-after-inbound-snapshot"),
          }),
        ).toEqual({ _tag: "Created", wakeUpId: "wakeup-after-inbound-snapshot" });
        expect(
          yield* wakeUps.consumeInbound({ channelLinkId: link.channelLinkId, userId }),
        ).toEqual({
          pending: [{ committedAt: new Date("2026-08-27T12:01:00.000Z"), source: later }],
          wakeUpId: "wakeup-after-inbound-snapshot",
        });
        yield* Deferred.succeed(senderRelease, undefined);
        yield* Fiber.join(firstDrain);
        const stored = yield* Effect.promise(() =>
          database
            .select({ state: whatsappWakeups.state, wakeUpId: whatsappWakeups.wakeup_id })
            .from(whatsappWakeups)
            .where(eq(whatsappWakeups.user_id, userId)),
        );
        expect(stored).toHaveLength(2);
        expect(Object.fromEntries(stored.map(({ state, wakeUpId }) => [wakeUpId, state]))).toEqual({
          "wakeup-after-inbound-snapshot": "consumed",
          "wakeup-before-inbound": "consumed",
        });
        expect(yield* wakeUps.drainPending()).toEqual({
          accepted: 0,
          ambiguous: 0,
          canceled: 0,
          rejected: 0,
        });
        expect((yield* Ref.get(calls)).length).toBe(1);
      }),
  ),
);

it.effect("never resends an ambiguous provider request", () =>
  withFixture(({ calls, link, nextFailure, sources, userId, wakeUps }) =>
    Effect.gen(function* () {
      const email = WhatsAppWakeUps.Source.cases.ScheduledEmail.make({
        identity: WhatsAppWakeUps.SourceIdentity.make("email-1"),
      });
      yield* Ref.set(sources, [
        { committedAt: new Date("2026-08-27T12:00:00.000Z"), source: email },
      ]);
      yield* Ref.set(
        nextFailure,
        new WhatsAppWakeUps.ProviderAmbiguous({
          cause: "connection ended after request start",
          failureClass: "connectionLost",
        }),
      );
      yield* wakeUps.request({
        channelLinkId: link.channelLinkId,
        source: email,
        traceId: WhatsAppWakeUps.TraceId.make("trace-ambiguous"),
        userId,
        wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-ambiguous"),
      });
      expect((yield* wakeUps.drainPending()).ambiguous).toBe(1);
      expect((yield* wakeUps.drainPending()).ambiguous).toBe(0);
      expect((yield* Ref.get(calls)).length).toBe(1);
    }),
  ),
);

it.effect("records a proven rejection as terminal without an automatic retry", () =>
  withFixture(({ calls, link, nextFailure, sources, userId, wakeUps }) =>
    Effect.gen(function* () {
      const source = WhatsAppWakeUps.Source.cases.ScheduledEmail.make({
        identity: WhatsAppWakeUps.SourceIdentity.make("email-rejected"),
      });
      yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
      yield* Ref.set(
        nextFailure,
        new WhatsAppWakeUps.ProviderRejected({ cause: "Meta rejected the template" }),
      );
      yield* wakeUps.request({
        channelLinkId: link.channelLinkId,
        source,
        traceId: WhatsAppWakeUps.TraceId.make("trace-rejected"),
        userId,
        wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-rejected"),
      });
      expect((yield* wakeUps.drainPending()).rejected).toBe(1);
      expect((yield* wakeUps.drainPending()).rejected).toBe(0);
      expect((yield* Ref.get(calls)).length).toBe(1);
    }),
  ),
);

it.effect("recovers only an expired pre-I/O lease", () =>
  withFixture(({ calls, database, link, sources, userId, wakeUps }) =>
    Effect.gen(function* () {
      const source = WhatsAppWakeUps.Source.cases.Reminder.make({
        identity: WhatsAppWakeUps.SourceIdentity.make("lease-reminder"),
      });
      yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
      const wakeUpId = WhatsAppWakeUps.WakeUpId.make("wakeup-expired-lease");
      yield* wakeUps.request({
        channelLinkId: link.channelLinkId,
        source,
        traceId: WhatsAppWakeUps.TraceId.make("trace-expired-lease"),
        userId,
        wakeUpId,
      });
      yield* Effect.promise(() =>
        database
          .update(whatsappWakeups)
          .set({ lease_expires_at: new Date(-1), lease_id: "abandoned-pre-io-lease" })
          .where(eq(whatsappWakeups.wakeup_id, wakeUpId)),
      );
      const result = yield* wakeUps.drainPending();
      const [stored] = yield* Effect.promise(() =>
        database
          .select({
            leaseId: whatsappWakeups.lease_id,
            safeFailureClass: whatsappWakeups.safe_failure_class,
            state: whatsappWakeups.state,
          })
          .from(whatsappWakeups)
          .where(eq(whatsappWakeups.wakeup_id, wakeUpId)),
      );
      expect({ calls: (yield* Ref.get(calls)).length, result, stored }).toEqual({
        calls: 1,
        result: { accepted: 1, ambiguous: 0, canceled: 0, rejected: 0 },
        stored: { leaseId: null, safeFailureClass: null, state: "accepted" },
      });
    }),
  ),
);

it.effect(
  "reconciles process interruption after provider I/O starts as ambiguous without resend",
  () =>
    withFixture(({ blockSender, calls, database, link, senderStarted, sources, userId, wakeUps }) =>
      Effect.gen(function* () {
        const source = WhatsAppWakeUps.Source.cases.DocumentBuild.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("interrupted-document"),
        });
        yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
        yield* Ref.set(blockSender, true);
        yield* wakeUps.request({
          channelLinkId: link.channelLinkId,
          source,
          traceId: WhatsAppWakeUps.TraceId.make("trace-interrupted"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-interrupted"),
        });
        const drain = yield* wakeUps.drainPending().pipe(Effect.forkChild);
        yield* Deferred.await(senderStarted);
        yield* Fiber.interrupt(drain);
        yield* Ref.set(blockSender, false);
        yield* Effect.promise(() =>
          database
            .update(whatsappWakeups)
            .set({ requested_at: new Date(-1) })
            .where(eq(whatsappWakeups.wakeup_id, "wakeup-interrupted")),
        );
        expect(yield* wakeUps.drainPending({ requestTimeout: 0 })).toEqual({
          accepted: 0,
          ambiguous: 1,
          canceled: 0,
          rejected: 0,
        });
        expect((yield* Ref.get(calls)).length).toBe(1);
        const [stored] = yield* Effect.promise(() =>
          database
            .select({
              failureClass: whatsappWakeups.safe_failure_class,
              state: whatsappWakeups.state,
            })
            .from(whatsappWakeups)
            .where(eq(whatsappWakeups.wakeup_id, "wakeup-interrupted")),
        );
        expect(stored).toEqual({ failureClass: "connectionLost", state: "ambiguous" });
      }),
    ),
);

it.effect("reconciles a revoked in-flight request as canceled while sending is inactive", () =>
  withFixture(
    ({
      blockSender,
      calls,
      channelLinks,
      database,
      link,
      senderStarted,
      sources,
      userId,
      wakeUps,
    }) =>
      Effect.gen(function* () {
        const source = WhatsAppWakeUps.Source.cases.ResearchReport.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("interrupted-revoked-report"),
        });
        yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
        yield* Ref.set(blockSender, true);
        yield* wakeUps.request({
          channelLinkId: link.channelLinkId,
          source,
          traceId: WhatsAppWakeUps.TraceId.make("trace-interrupted-revoked"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-interrupted-revoked"),
        });
        const drain = yield* wakeUps.drainPending().pipe(Effect.forkChild);
        yield* Deferred.await(senderStarted);
        yield* channelLinks.revoke({
          actorId: ChannelLinks.ChannelLinkActorId.make(`user:${userId}`),
          channelLinkId: link.channelLinkId,
          ownerUserId: userId,
          reason: ChannelLinks.ChannelLinkRevocationReason.make("User disconnected WhatsApp"),
        });
        yield* Fiber.interrupt(drain);
        yield* Effect.promise(() =>
          database
            .update(whatsappWakeups)
            .set({ requested_at: new Date(-1) })
            .where(eq(whatsappWakeups.wakeup_id, "wakeup-interrupted-revoked")),
        );
        expect(yield* wakeUps.drainPending({ requestTimeout: 0, sendPending: false })).toEqual({
          accepted: 0,
          ambiguous: 0,
          canceled: 1,
          rejected: 0,
        });
        expect((yield* Ref.get(calls)).length).toBe(1);
        const [stored] = yield* Effect.promise(() =>
          database
            .select({
              failureClass: whatsappWakeups.safe_failure_class,
              outcome: whatsappWakeups.provider_outcome,
              state: whatsappWakeups.state,
            })
            .from(whatsappWakeups)
            .where(eq(whatsappWakeups.wakeup_id, "wakeup-interrupted-revoked")),
        );
        expect(stored).toEqual({
          failureClass: "authorityLost",
          outcome: "ambiguous",
          state: "canceled",
        });
      }),
  ),
);

it.effect("cancels a pending latch atomically with Channel Link revocation", () =>
  withFixture(({ calls, channelLinks, link, sources, userId, wakeUps }) =>
    Effect.gen(function* () {
      const source = WhatsAppWakeUps.Source.cases.ResearchReport.make({
        identity: WhatsAppWakeUps.SourceIdentity.make("revoked-report"),
      });
      yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
      yield* wakeUps.request({
        channelLinkId: link.channelLinkId,
        source,
        traceId: WhatsAppWakeUps.TraceId.make("trace-revoked"),
        userId,
        wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-revoked"),
      });
      yield* channelLinks.revoke({
        actorId: ChannelLinks.ChannelLinkActorId.make(`user:${userId}`),
        channelLinkId: link.channelLinkId,
        ownerUserId: userId,
        reason: ChannelLinks.ChannelLinkRevocationReason.make("User disconnected WhatsApp"),
      });
      expect((yield* wakeUps.drainPending()).accepted).toBe(0);
      expect(yield* Ref.get(calls)).toEqual([]);
    }),
  ),
);

it.effect("records a Channel Link revocation that races an already-started provider call", () =>
  withFixture(
    ({
      blockSender,
      channelLinks,
      database,
      link,
      senderRelease,
      senderStarted,
      sources,
      userId,
      wakeUps,
    }) =>
      Effect.gen(function* () {
        const source = WhatsAppWakeUps.Source.cases.ResearchReport.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("revoked-race-report"),
        });
        yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
        yield* Ref.set(blockSender, true);
        yield* wakeUps.request({
          channelLinkId: link.channelLinkId,
          source,
          traceId: WhatsAppWakeUps.TraceId.make("trace-revoked-race"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-revoked-race"),
        });
        const drain = yield* wakeUps.drainPending().pipe(Effect.forkChild);
        yield* Deferred.await(senderStarted);
        yield* channelLinks.revoke({
          actorId: ChannelLinks.ChannelLinkActorId.make(`user:${userId}`),
          channelLinkId: link.channelLinkId,
          ownerUserId: userId,
          reason: ChannelLinks.ChannelLinkRevocationReason.make("User disconnected WhatsApp"),
        });
        yield* Deferred.succeed(senderRelease, undefined);
        yield* Fiber.join(drain);
        const [stored] = yield* Effect.promise(() =>
          database
            .select({ outcome: whatsappWakeups.provider_outcome, state: whatsappWakeups.state })
            .from(whatsappWakeups)
            .where(eq(whatsappWakeups.wakeup_id, "wakeup-revoked-race")),
        );
        expect(stored).toEqual({ outcome: "accepted", state: "canceled" });
      }),
  ),
);

it.effect("does not erase an in-flight request before its provider outcome settles", () =>
  withFixture(
    ({ blockSender, database, link, senderRelease, senderStarted, sources, userId, wakeUps }) =>
      Effect.gen(function* () {
        const source = WhatsAppWakeUps.Source.cases.Reminder.make({
          identity: WhatsAppWakeUps.SourceIdentity.make("deletion-race-reminder"),
        });
        yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
        yield* Ref.set(blockSender, true);
        yield* wakeUps.request({
          channelLinkId: link.channelLinkId,
          source,
          traceId: WhatsAppWakeUps.TraceId.make("trace-deletion-race"),
          userId,
          wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-deletion-race"),
        });
        const drain = yield* wakeUps.drainPending().pipe(Effect.forkChild);
        yield* Deferred.await(senderStarted);
        const teardownCount = yield* Ref.make(-1);
        const portLayer = AccountDeletionComposition.portLayer({
          integrationAuthorityDeletion:
            AccountDeletionComposition.integrationAuthorityDeletionNotDelivered,
          OSFO_DIRECTORY: {
            getByName: () => ({
              deleteAgent: () => Promise.resolve(),
              quiesceAgentAccountDeletion: async () => {
                const rows = await database
                  .select({ wakeUpId: whatsappWakeups.wakeup_id })
                  .from(whatsappWakeups)
                  .where(eq(whatsappWakeups.user_id, userId));
                await Effect.runPromise(Ref.set(teardownCount, rows.length));
              },
            }),
          },
        }).pipe(Layer.provide(Db.layerFromDatabase(database)));
        expect(
          yield* AccountDeletion.Port.pipe(
            Effect.flatMap((port) =>
              port.agents.quiesce(AgentId.make("agent-deletion-race"), userId),
            ),
            Effect.flip,
            Effect.map((failure) => failure._tag),
            Effect.provide(portLayer),
          ),
        ).toBe("AccountDeletionUnavailable");
        expect(yield* Ref.get(teardownCount)).toBe(-1);
        yield* Deferred.succeed(senderRelease, undefined);
        yield* Fiber.join(drain);
        yield* AccountDeletion.Port.pipe(
          Effect.flatMap((port) =>
            port.agents.quiesce(AgentId.make("agent-deletion-race"), userId),
          ),
          Effect.provide(portLayer),
        );
        expect(yield* Ref.get(teardownCount)).toBe(0);
      }),
  ),
);

it.effect("removes every User Wake-up row before Agent teardown begins", () =>
  withFixture(({ database, link, sources, userId, wakeUps }) =>
    Effect.gen(function* () {
      const source = WhatsAppWakeUps.Source.cases.Reminder.make({
        identity: WhatsAppWakeUps.SourceIdentity.make("deletion-reminder"),
      });
      yield* Ref.set(sources, [{ committedAt: new Date("2026-08-27T12:00:00.000Z"), source }]);
      yield* wakeUps.request({
        channelLinkId: link.channelLinkId,
        source,
        traceId: WhatsAppWakeUps.TraceId.make("trace-deletion"),
        userId,
        wakeUpId: WhatsAppWakeUps.WakeUpId.make("wakeup-deletion"),
      });
      const countAtAgentTeardown = yield* Ref.make(-1);
      const portLayer = AccountDeletionComposition.portLayer({
        integrationAuthorityDeletion:
          AccountDeletionComposition.integrationAuthorityDeletionNotDelivered,
        OSFO_DIRECTORY: {
          getByName: () => ({
            deleteAgent: () => Promise.resolve(),
            quiesceAgentAccountDeletion: async () => {
              const rows = await database
                .select({ wakeUpId: whatsappWakeups.wakeup_id })
                .from(whatsappWakeups)
                .where(eq(whatsappWakeups.user_id, userId));
              await Effect.runPromise(Ref.set(countAtAgentTeardown, rows.length));
            },
          }),
        },
      }).pipe(Layer.provide(Db.layerFromDatabase(database)));
      yield* AccountDeletion.Port.pipe(
        Effect.flatMap((port) => port.agents.quiesce(AgentId.make("agent-deletion"), userId)),
        Effect.provide(portLayer),
      );
      expect(yield* Ref.get(countAtAgentTeardown)).toBe(0);
      expect(
        yield* Effect.promise(() =>
          database
            .select({ wakeUpId: whatsappWakeups.wakeup_id })
            .from(whatsappWakeups)
            .where(eq(whatsappWakeups.user_id, userId)),
        ),
      ).toEqual([]);
      expect(
        yield* Effect.promise(() =>
          database
            .select({ wakeUpId: whatsappWakeupSources.wakeup_id })
            .from(whatsappWakeupSources)
            .where(eq(whatsappWakeupSources.wakeup_id, "wakeup-deletion")),
        ),
      ).toEqual([]);
    }),
  ),
);

const withFixture = <A, E>(
  use: (fixture: Fixture) => Effect.Effect<A, E>,
): Effect.Effect<A, E | Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const identity = yield* Effect.promise(() =>
        app.auth.mintVerifiedUser({
          profile: { helpAreas: ["research"], locale: "en", preferredName: "Wake Up" },
        }),
      );
      const userId = UserId.make(identity.userId);
      const endpoint = `1${Array.from(identity.userId, (character) => character.codePointAt(0) ?? 0)
        .map((codePoint) => codePoint % 10)
        .join("")
        .slice(0, 10)}`;
      const sources = yield* Ref.make<ReadonlyArray<WhatsAppWakeUps.CommittedSource>>([]);
      const inspectionOverride = yield* Ref.make<WhatsAppWakeUps.CommittedSource | null>(null);
      const inspectionGateIdentity = yield* Ref.make<string | null>(null);
      const inspectionStarted = yield* Deferred.make<void>();
      const inspectionRelease = yield* Deferred.make<void>();
      const exposedSources = yield* Ref.make<ReadonlyArray<WhatsAppWakeUps.CommittedSource>>([]);
      const failExposure = yield* Ref.make(false);
      const blockExposure = yield* Ref.make(false);
      const exposureStarted = yield* Deferred.make<void>();
      const exposureRelease = yield* Deferred.make<void>();
      const calls = yield* Ref.make<
        ReadonlyArray<{ readonly endpoint: string; readonly locale: "en" | "es" }>
      >([]);
      const blockSender = yield* Ref.make(false);
      const senderStarted = yield* Deferred.make<void>();
      const senderRelease = yield* Deferred.make<void>();
      const nextFailure = yield* Ref.make<
        WhatsAppWakeUps.ProviderAmbiguous | WhatsAppWakeUps.ProviderRejected | null
      >(null);
      const sourceLayer = Layer.succeed(
        WhatsAppWakeUps.SourceAuthority,
        WhatsAppWakeUps.SourceAuthority.of({
          exposePending: (owner, committed) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(exposureStarted, undefined);
              if (yield* Ref.get(blockExposure)) yield* Deferred.await(exposureRelease);
              if (yield* Ref.get(failExposure)) {
                return yield* new WhatsAppWakeUps.WakeUpUnavailable({
                  cause: "source owner unavailable",
                  operation: "test.exposePending",
                });
              }
              if (owner === userId) {
                yield* Ref.set(exposedSources, committed);
                yield* Ref.update(sources, (current) =>
                  current.filter(
                    (candidate) =>
                      !committed.some(
                        ({ source }) =>
                          source._tag === candidate.source._tag &&
                          source.identity === candidate.source.identity,
                      ),
                  ),
                );
              }
              return undefined;
            }),
          inspect: (owner, source) =>
            Effect.gen(function* () {
              const override = yield* Ref.get(inspectionOverride);
              const committed =
                override ??
                (yield* Ref.get(sources)).find(
                  (candidate) =>
                    owner === userId &&
                    candidate.source._tag === source._tag &&
                    candidate.source.identity === source.identity,
                ) ??
                null;
              if ((yield* Ref.get(inspectionGateIdentity)) === source.identity) {
                yield* Deferred.succeed(inspectionStarted, undefined);
                yield* Deferred.await(inspectionRelease);
              }
              return committed;
            }),
          pendingForUser: (owner) => (owner === userId ? Ref.get(sources) : Effect.succeed([])),
        }),
      );
      const senderLayer = Layer.succeed(
        WhatsAppWakeUps.Sender,
        WhatsAppWakeUps.Sender.of({
          sendTemplate: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (current) => [...current, input]);
              yield* Deferred.succeed(senderStarted, undefined);
              if (yield* Ref.get(blockSender)) yield* Deferred.await(senderRelease);
              const failure = yield* Ref.getAndSet(nextFailure, null);
              if (failure !== null) return yield* failure;
              return "meta-message-1";
            }),
        }),
      );
      const base = Layer.mergeAll(Db.layer({ db: env.DB }), BrowserCrypto.layer);
      const services = Layer.merge(
        ChannelLinks.layerFromConfig(loadConfig(env)),
        WhatsAppWakeUps.layerWithoutDependencies.pipe(
          Layer.provide(Layer.merge(sourceLayer, senderLayer)),
        ),
      );
      const layer = services.pipe(Layer.provideMerge(base));
      return yield* Effect.gen(function* () {
        const database = yield* Db.database;
        const channelLinks = yield* ChannelLinks.Service;
        const wakeUps = yield* WhatsAppWakeUps.Service;
        const ensured = yield* channelLinks.ensure(
          ChannelLinks.ChannelAddress.make({
            authorId: ChannelLinks.ChannelAuthorId.make(endpoint),
            channelId: ChannelLinks.ChannelId.make("whatsapp"),
          }),
        );
        if (ensured._tag !== "Invited") return yield* Effect.die(new Error("Invite missing"));
        const token = yield* Schema.decodeEffect(ChannelLinks.ChannelLinkInviteToken)(
          ensured.verificationUrl.pathname.split("/").at(-1) ?? "",
        );
        const link = yield* channelLinks.accept(Redacted.make(token), userId);
        return yield* use({
          blockExposure,
          calls,
          blockSender,
          channelLinks,
          database,
          endpoint,
          exposedSources,
          exposureRelease,
          exposureStarted,
          failExposure,
          inspectionOverride,
          inspectionGateIdentity,
          inspectionRelease,
          inspectionStarted,
          link,
          nextFailure,
          senderStarted,
          senderRelease,
          sources,
          userId,
          wakeUps,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

interface Fixture {
  readonly blockExposure: Ref.Ref<boolean>;
  readonly blockSender: Ref.Ref<boolean>;
  readonly calls: Ref.Ref<
    ReadonlyArray<{ readonly endpoint: string; readonly locale: "en" | "es" }>
  >;
  readonly channelLinks: ChannelLinks.Interface;
  readonly database: Database;
  readonly endpoint: string;
  readonly exposedSources: Ref.Ref<ReadonlyArray<WhatsAppWakeUps.CommittedSource>>;
  readonly exposureRelease: Deferred.Deferred<void>;
  readonly exposureStarted: Deferred.Deferred<void>;
  readonly failExposure: Ref.Ref<boolean>;
  readonly inspectionOverride: Ref.Ref<WhatsAppWakeUps.CommittedSource | null>;
  readonly inspectionGateIdentity: Ref.Ref<string | null>;
  readonly inspectionRelease: Deferred.Deferred<void>;
  readonly inspectionStarted: Deferred.Deferred<void>;
  readonly link: typeof ChannelLinks.ChannelLink.Type;
  readonly nextFailure: Ref.Ref<
    WhatsAppWakeUps.ProviderAmbiguous | WhatsAppWakeUps.ProviderRejected | null
  >;
  readonly senderStarted: Deferred.Deferred<void>;
  readonly senderRelease: Deferred.Deferred<void>;
  readonly sources: Ref.Ref<ReadonlyArray<WhatsAppWakeUps.CommittedSource>>;
  readonly userId: UserId;
  readonly wakeUps: WhatsAppWakeUps.Interface;
}

const awaitPostgresLockWaiters = (
  client: Sql,
  expected: number,
  attemptsRemaining = 500,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const [row] = yield* Effect.promise(
      () =>
        client<Array<{ readonly waiting_count: number }>>`
        select count(*)::integer as waiting_count
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
      `,
    );
    if (row !== undefined && row.waiting_count >= expected) return undefined;
    if (attemptsRemaining === 0) {
      return yield* Effect.die(
        new Error(
          `Expected ${expected} PostgreSQL lock waiters, observed ${row?.waiting_count ?? 0}`,
        ),
      );
    }
    yield* Effect.yieldNow;
    yield* awaitPostgresLockWaiters(client, expected, attemptsRemaining - 1);
    return undefined;
  });
