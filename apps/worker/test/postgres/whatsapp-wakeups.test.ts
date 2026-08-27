import { BrowserCrypto } from "@effect/platform-browser";
import type { Database } from "@osfo/db";
import { allowanceUsage } from "@osfo/db/schema/allowances";
import { whatsappWakeups, whatsappWakeupSources } from "@osfo/db/schema/whatsapp-wakeups";
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber, Layer, Redacted, Ref, Schema } from "effect";

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
      const exposedSources = yield* Ref.make<ReadonlyArray<WhatsAppWakeUps.CommittedSource>>([]);
      const failExposure = yield* Ref.make(false);
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
              if (yield* Ref.get(failExposure)) {
                return yield* new WhatsAppWakeUps.WakeUpUnavailable({
                  cause: "source owner unavailable",
                  operation: "test.exposePending",
                });
              }
              if (owner === userId) yield* Ref.set(exposedSources, committed);
              return undefined;
            }),
          inspect: (owner, source) =>
            Ref.get(inspectionOverride).pipe(
              Effect.flatMap((override) =>
                override === null
                  ? Ref.get(sources).pipe(
                      Effect.map(
                        (current) =>
                          current.find(
                            (candidate) =>
                              owner === userId &&
                              candidate.source._tag === source._tag &&
                              candidate.source.identity === source.identity,
                          ) ?? null,
                      ),
                    )
                  : Effect.succeed(override),
              ),
            ),
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
          calls,
          blockSender,
          channelLinks,
          database,
          endpoint,
          exposedSources,
          failExposure,
          inspectionOverride,
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
  readonly blockSender: Ref.Ref<boolean>;
  readonly calls: Ref.Ref<
    ReadonlyArray<{ readonly endpoint: string; readonly locale: "en" | "es" }>
  >;
  readonly channelLinks: ChannelLinks.Interface;
  readonly database: Database;
  readonly endpoint: string;
  readonly exposedSources: Ref.Ref<ReadonlyArray<WhatsAppWakeUps.CommittedSource>>;
  readonly failExposure: Ref.Ref<boolean>;
  readonly inspectionOverride: Ref.Ref<WhatsAppWakeUps.CommittedSource | null>;
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
