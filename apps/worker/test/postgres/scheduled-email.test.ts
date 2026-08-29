/* oxlint-disable effecttsgo/any-unknown-in-error-context, effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/run-effect-inside-effect, effecttsgo/strict-effect-provide, osfo/no-reflect-get, osfo/no-unknown-parameters, vitest/no-standalone-expect -- These tests own native PostgreSQL clients and deterministic lifecycle timestamps; the public-boundary journey proxies Cloudflare's generated binding and decodes its unknown RPC input immediately. */
/* oxlint-disable eslint/no-underscore-dangle -- Assertions inspect canonical tagged outcomes. */
import { createDb, type Database } from "@osfo/db";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { channelLinks } from "@osfo/db/schema/channel-links";
import { documentBuilds } from "@osfo/db/schema/document-builds";
import { researchReports } from "@osfo/db/schema/research-reports";
import { scheduledEmails } from "@osfo/db/schema/scheduled-emails";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Layer, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import postgres from "postgres";

import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  AgentId,
  AllowancePeriodId,
  ChannelLinkId,
  ManifestVersion,
  SessionId,
  ThinkSubmissionId,
  UserId,
} from "../../src/domain";
import { ActionId } from "../../src/domain/action-execution";
import { AuthSessionId } from "../../src/domain/auth-session";
import { quiesceWorkflows } from "../../src/composition/account-deletion";
import type { Bindings } from "../../src/composition/account-deletion";
import { scheduledEmailSourceAuthority } from "../../src/composition/whatsapp-wakeups";
import { ScheduledEmailFollowUpPostgres } from "../../src/integrations/postgres/scheduled-email-follow-up";
import { ScheduledEmailPostgres } from "../../src/integrations/postgres/scheduled-email";
import { ScheduledEmail } from "../../src/services/scheduled-email";
import { ScheduledEmailFollowUp } from "../../src/services/scheduled-email-follow-up";
import type { IntegrationEffectCompleted } from "../../src/services/integrations";
import { makeRecord } from "../../src/services/scheduled-email-test-fixture";
import { WhatsAppWakeUps } from "../../src/services/whatsapp-wakeups";
import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
import worker from "../../src/worker";

const admittedAt = new Date("2026-08-28T11:00:00.000Z");
const dueAt = new Date("2026-08-28T12:00:00.000Z");
const sendAt = new Date("2026-08-28T12:00:01.000Z");

it.effect("counts Research, Document, and Scheduled Email under one serialized active limit", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const identity = "shared-active";
      const seeded = yield* seedUser(database, identity);
      yield* Effect.promise(() =>
        database.insert(researchReports).values(researchRow(seeded, identity)),
      );
      yield* Effect.promise(() =>
        database.insert(documentBuilds).values(documentRow(seeded, identity)),
      );
      const result = yield* ScheduledEmailPostgres.make(database)
        .admit(record(seeded, identity), 2n)
        .pipe(Effect.result);
      expect(result).toMatchObject({
        failure: { _tag: "Denied", reason: "liveResourceLimitReached" },
      });
    }),
  ),
);

it.effect("serializes cancel against the irreversible beginSend claim", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "cancel-race");
      const email = record(seeded, "cancel-race");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* TestClock.setTime(sendAt.getTime());
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      const [send, cancel] = yield* Effect.all(
        [
          persistence.beginSend(email.workflowId, email.inputDigest, sendAt).pipe(Effect.result),
          persistence.requestCancel(email.workflowId, email.userId, sendAt).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const retained = yield* persistence.inspect(email.workflowId);
      expect(retained?.cancelRequestedAt).not.toBeNull();
      expect(retained?.state === "waiting" || retained?.state === "sending").toBe(true);
      if (retained?.state === "waiting") {
        expect(send).toMatchObject({ failure: { _tag: "ScheduledEmailConflict" } });
      } else {
        expect(send).toMatchObject({ success: { _tag: "Acquired", email: { state: "sending" } } });
      }
      expect(cancel).toMatchObject({ success: { cancelRequestedAt: sendAt } });
      yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "canceled",
        null,
        null,
        "test-cleanup",
        sendAt,
      );
    }),
  ),
);

it.effect("elects exactly one send claimant under concurrent due work", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "send-claim-race");
      const email = record(seeded, "send-claim-race");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);

      const claims = yield* Effect.all(
        [
          persistence.beginSend(email.workflowId, email.inputDigest, sendAt),
          persistence.beginSend(email.workflowId, email.inputDigest, sendAt),
        ],
        { concurrency: "unbounded" },
      );

      expect(new Set(claims.map((claim) => claim._tag))).toEqual(new Set(["Acquired", "Existing"]));
      expect(claims.every((claim) => claim.email.state === "sending")).toBe(true);
    }),
  ),
);

it.effect("atomically elects exactly one NotStarted retry claimant", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "send-retry-claim-race");
      const email = record(seeded, "send-retry-claim-race");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      const initial = yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      const retryAt = new Date(sendAt.getTime() + 1_000);

      const claims = yield* Effect.all(
        [
          persistence.retrySend(
            email.workflowId,
            email.inputDigest,
            initial.email.sendClaimGeneration,
            retryAt,
          ),
          persistence.retrySend(
            email.workflowId,
            email.inputDigest,
            initial.email.sendClaimGeneration,
            retryAt,
          ),
        ],
        { concurrency: "unbounded" },
      );

      expect(new Set(claims.map((claim) => claim._tag))).toEqual(new Set(["Acquired", "Existing"]));
      expect(claims.every((claim) => claim.email.sendClaimGeneration === 2)).toBe(true);
      expect(
        claims.every((claim) => claim.email.sendStartedAt?.getTime() === retryAt.getTime()),
      ).toBe(true);
    }),
  ),
);

it.effect(
  "allows only the acquired claimant to invoke Gmail when the first send is NotApplied",
  () =>
    withDatabase((database) =>
      Effect.gen(function* () {
        const seeded = yield* seedUser(database, "send-execution-race");
        const candidate = record(seeded, "send-execution-race");
        const email = {
          ...candidate,
          cloudflareInstanceId: yield* ScheduledEmail.cloudflareInstanceIdFor(candidate.workflowId),
        };
        const persistence = ScheduledEmailPostgres.make(database);
        const loadCurrentAuthorization = ScheduledEmailPostgres.makeCurrentAuthorization(database);
        const firstSendCanFinish = yield* Deferred.make<void>();
        let sendInvocations = 0;
        yield* persistence.admit(email, 5n);
        yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
        yield* TestClock.setTime(sendAt.getTime());

        const port = ScheduledEmail.Port.of({
          commitTerminalFollowUp: () => Effect.void,
          currentAuthorization: (retained, authority) =>
            loadCurrentAuthorization(retained, authority).pipe(
              Effect.map((current) => ({
                ...current,
                allowance:
                  current.allowance._tag === "Metered"
                    ? { ...current.allowance, plan: "adventurer" as const }
                    : current.allowance,
                authority: {
                  _tag: "DurableTrigger" as const,
                  triggerId: retained.workflowId,
                  triggerType: "workflow" as const,
                  userId: retained.userId,
                },
                originatingAuthority: {
                  _tag: "DurableTrigger" as const,
                  triggerId: retained.workflowId,
                  triggerType: "workflow" as const,
                },
                gmailConnection: {
                  _tag: "Connected" as const,
                  toolkit: "gmail" as const,
                  userId: retained.userId,
                },
                integrationConnections: [
                  {
                    _tag: "Connected" as const,
                    toolkit: "gmail" as const,
                    userId: retained.userId,
                  },
                ],
                subscription: { ...current.subscription, plan: "adventurer" as const },
              })),
            ),
          persistence,
          reconcileSend: () =>
            Deferred.succeed(firstSendCanFinish, undefined).pipe(
              Effect.as({ _tag: "NotStarted" as const }),
            ),
          recordSendOutcome: () => Effect.void,
          recordWorkflowStart: () => Effect.void,
          send: (_retained, authorize) =>
            authorize.pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  sendInvocations += 1;
                  if (sendInvocations === 1) yield* Deferred.await(firstSendCanFinish);
                  else yield* Deferred.succeed(firstSendCanFinish, undefined);
                  return yield* new ScheduledEmail.SendNotApplied({
                    message: "Provider proved that the send did not start",
                    providerLogId: "gmail-not-applied",
                  });
                }),
              ),
            ),
          workflow: { create: () => Effect.void, terminate: () => Effect.void },
        });
        const serviceLayer = ScheduledEmail.layerWithoutDependencies.pipe(
          Layer.provide(Layer.succeed(ScheduledEmail.Port, port)),
        );

        yield* Effect.all(
          [
            ScheduledEmail.Service.pipe(
              Effect.flatMap((service) => service.sendDue(payloadFor(email))),
            ),
            ScheduledEmail.Service.pipe(
              Effect.flatMap((service) => service.sendDue(payloadFor(email))),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(serviceLayer));

        expect(yield* persistence.inspect(email.workflowId)).toMatchObject({
          providerLogId: "gmail-not-applied",
          safeFailureCode: "send-not-applied",
          sendAccountingBasis: null,
          sendOutcome: "notApplied",
          state: "failure",
        });
        expect(sendInvocations).toBe(1);
      }),
    ),
);

it.effect(
  "repairs a committed cancel request immediately without waiting for the due instant",
  () =>
    withDatabase((database) =>
      Effect.gen(function* () {
        const seeded = yield* seedUser(database, "cancel-crash-repair");
        const candidate = record(seeded, "cancel-crash-repair");
        const email = {
          ...candidate,
          cloudflareInstanceId: yield* ScheduledEmail.cloudflareInstanceIdFor(candidate.workflowId),
        };
        const persistence = ScheduledEmailPostgres.make(database);
        yield* persistence.admit(email, 5n);
        yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
        yield* persistence.requestCancel(email.workflowId, email.userId, admittedAt);

        expect(
          yield* ScheduledEmailPostgres.reconciliationBatch(
            database,
            new Date("2026-08-28T11:01:00.000Z"),
            20,
          ),
        ).toContainEqual(
          expect.objectContaining({ kind: "claimed", workflowId: email.workflowId }),
        );

        let followUps = 0;
        const port = ScheduledEmail.Port.of({
          commitTerminalFollowUp: () =>
            Effect.sync(() => {
              followUps += 1;
            }),
          currentAuthorization: () => Effect.die(new Error("Cancel repair needs no authority")),
          persistence,
          reconcileSend: () => Effect.die(new Error("Cancel repair must not inspect Gmail")),
          recordSendOutcome: () => Effect.void,
          recordWorkflowStart: () => Effect.void,
          send: () => Effect.die(new Error("Cancel repair must not send Gmail")),
          workflow: { create: () => Effect.void, terminate: () => Effect.void },
        });
        yield* TestClock.setTime(new Date("2026-08-28T11:01:00.000Z").getTime());
        const repaired = yield* ScheduledEmail.Service.pipe(
          Effect.flatMap((service) => service.recoverClaimed(payloadFor(email))),
          Effect.provide(
            ScheduledEmail.layerWithoutDependencies.pipe(
              Layer.provide(Layer.succeed(ScheduledEmail.Port, port)),
            ),
          ),
        );
        expect(repaired).toMatchObject({ safeFailureCode: "cancel-requested", state: "canceled" });
        expect(followUps).toBe(1);
        expect(yield* ScheduledEmailPostgres.countActiveForUser(database, email.userId)).toBe(0n);
      }),
    ),
);

it.effect("expires terminal ambiguity inspection after the provider evidence horizon", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "evidence-horizon");
      const email = record(seeded, "evidence-horizon");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "failure",
        "ambiguous",
        null,
        "send-outcome-unknown",
        new Date(sendAt.getTime() + 120_000),
      );
      yield* persistence.markWorkflowStartAccounted(
        email.workflowId,
        email.inputDigest,
        new Date(sendAt.getTime() + 121_000),
      );
      const followUps = ScheduledEmailFollowUpPostgres.make(database);
      const notificationId = ScheduledEmailFollowUp.NotificationId.make(
        `${email.workflowId}-terminal`,
      );
      yield* followUps.claimTerminal(
        (yield* persistence.inspect(email.workflowId)) ?? email,
        notificationId,
        new Date(sendAt.getTime() + 122_000),
      );
      yield* followUps.selectDeliverySession(notificationId, email.sessionId);
      yield* followUps.markAccepted(
        notificationId,
        ThinkSubmissionId.make("evidence-horizon-submission"),
        new Date(sendAt.getTime() + 123_000),
      );
      yield* followUps.markWakeRequested(notificationId, new Date(sendAt.getTime() + 124_000));

      expect(
        yield* ScheduledEmailPostgres.reconciliationBatch(
          database,
          new Date(sendAt.getTime() + 240_000),
          20,
        ),
      ).toContainEqual(expect.objectContaining({ workflowId: email.workflowId }));
      expect(
        (yield* ScheduledEmailPostgres.reconciliationBatch(
          database,
          new Date(sendAt.getTime() + 300_000),
          20,
        )).some(({ workflowId }) => workflowId === email.workflowId),
      ).toBe(true);
      const finalizedAt = new Date(sendAt.getTime() + 300_001);
      yield* persistence.finalizeAmbiguousAccounting(
        email.workflowId,
        email.inputDigest,
        finalizedAt,
      );
      yield* Effect.promise(() =>
        database.insert(allowanceUsage).values({
          allowance_kind: "gmailSends",
          allowance_period_id: email.allowancePeriodId,
          basis: "conservative",
          quantity: 1n,
          source_id: email.actionId,
          source_type: "integrationAction",
          user_id: email.userId,
        }),
      );
      yield* persistence.markSendAccounted(email.workflowId, email.inputDigest, finalizedAt);
      expect(
        (yield* ScheduledEmailPostgres.reconciliationBatch(
          database,
          new Date(sendAt.getTime() + 300_002),
          20,
        )).some(({ workflowId }) => workflowId === email.workflowId),
      ).toBe(false);
      yield* insertDeletionFence(database, seeded, "evidence-horizon");
      expect(
        yield* ScheduledEmailPostgres.quiesceForAccountDeletion(database, email.userId, sendAt),
      ).toMatchObject({ _tag: "Ready" });
    }),
  ),
);

it.effect("marks direct NotApplied accounting resolved without a Gmail fact or repeat repair", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "direct-not-applied-accounting");
      const email = record(seeded, "direct-not-applied-accounting");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      const failed = yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "failure",
        "notApplied",
        "direct-not-applied-log",
        "send-not-applied",
        sendAt,
      );
      yield* persistence.markWorkflowStartAccounted(email.workflowId, email.inputDigest, sendAt);
      const followUps = ScheduledEmailFollowUpPostgres.make(database);
      const notificationId = ScheduledEmailFollowUp.NotificationId.make(
        `${email.workflowId}-terminal`,
      );
      yield* followUps.claimTerminal(failed, notificationId, sendAt);
      yield* followUps.selectDeliverySession(notificationId, email.sessionId);
      yield* followUps.markAccepted(
        notificationId,
        ThinkSubmissionId.make("direct-not-applied-accounting-submission"),
        sendAt,
      );
      yield* followUps.markWakeRequested(notificationId, sendAt);

      expect(
        (yield* ScheduledEmailPostgres.reconciliationBatch(database, sendAt, 20)).some(
          ({ workflowId }) => workflowId === email.workflowId,
        ),
      ).toBe(true);
      const resolved = yield* persistence.markSendAccounted(
        email.workflowId,
        email.inputDigest,
        sendAt,
      );
      expect(resolved).toMatchObject({
        sendAccountedAt: sendAt,
        sendAccountingBasis: null,
        sendOutcome: "notApplied",
      });
      expect(
        (yield* ScheduledEmailPostgres.reconciliationBatch(
          database,
          new Date(sendAt.getTime() + 1),
          20,
        )).some(({ workflowId }) => workflowId === email.workflowId),
      ).toBe(false);
      expect(
        yield* Effect.promise(() =>
          database
            .select({ basis: allowanceUsage.basis })
            .from(allowanceUsage)
            .where(eq(allowanceUsage.source_id, email.actionId)),
        ),
      ).toEqual([]);
    }),
  ),
);

it.effect("lets an in-horizon reconciliation claim beat exact-horizon finalization", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "reconciliation-finalization-race");
      const email = record(seeded, "reconciliation-finalization-race");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "failure",
        "ambiguous",
        null,
        "send-outcome-unknown",
        new Date(sendAt.getTime() + 120_000),
      );
      const claimedAt = new Date(sendAt.getTime() + 299_000);
      const claim = yield* persistence.claimTerminalReconciliation(
        email.workflowId,
        email.inputDigest,
        claimedAt,
        new Date(sendAt.getTime() + 359_000),
      );
      expect(claim).toMatchObject({ _tag: "Acquired", claimedAt });

      yield* Effect.all(
        [
          persistence.completeTerminalReconciliation(
            email.workflowId,
            email.inputDigest,
            claimedAt,
            { _tag: "NotApplied", providerLogId: "authoritative-not-applied" },
            new Date(sendAt.getTime() + 299_999),
          ),
          persistence.finalizeAmbiguousAccounting(
            email.workflowId,
            email.inputDigest,
            new Date(sendAt.getTime() + 300_000),
          ),
        ],
        { concurrency: "unbounded" },
      );

      expect(yield* persistence.inspect(email.workflowId)).toMatchObject({
        providerLogId: "authoritative-not-applied",
        sendAccountingBasis: null,
        sendOutcome: "notApplied",
      });
      expect(
        yield* Effect.promise(() =>
          database
            .select()
            .from(allowanceUsage)
            .where(eq(allowanceUsage.source_id, email.actionId)),
        ),
      ).toEqual([]);
    }),
  ),
);

it.effect("recovers a crashed in-horizon reconciliation before conservative finalization", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "expired-reconciliation-claim");
      const email = record(seeded, "expired-reconciliation-claim");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "failure",
        "ambiguous",
        null,
        "send-outcome-unknown",
        new Date(sendAt.getTime() + 120_000),
      );
      const claimedAt = new Date(sendAt.getTime() + 299_000);
      const leaseExpiresAt = new Date(sendAt.getTime() + 301_000);
      yield* persistence.claimTerminalReconciliation(
        email.workflowId,
        email.inputDigest,
        claimedAt,
        leaseExpiresAt,
      );

      expect(
        yield* persistence.finalizeAmbiguousAccounting(
          email.workflowId,
          email.inputDigest,
          new Date(sendAt.getTime() + 300_000),
        ),
      ).toMatchObject({ sendAccountingBasis: null });
      const recoveredAt = new Date(leaseExpiresAt.getTime() + 1);
      const recovered = yield* persistence.claimTerminalReconciliation(
        email.workflowId,
        email.inputDigest,
        recoveredAt,
        new Date(recoveredAt.getTime() + 60_000),
      );
      expect(recovered).toMatchObject({
        _tag: "Acquired",
        claimedAt: recoveredAt,
        email: {
          sendReconciliationLeaseExpiresAt: new Date(leaseExpiresAt.getTime() + 60_000),
        },
      });
      expect(
        yield* persistence.completeTerminalReconciliation(
          email.workflowId,
          email.inputDigest,
          recoveredAt,
          { _tag: "NotApplied", providerLogId: "recovered-not-applied" },
          new Date(recoveredAt.getTime() + 1_000),
        ),
      ).toMatchObject({
        providerLogId: "recovered-not-applied",
        sendAccountingBasis: null,
        sendOutcome: "notApplied",
      });
    }),
  ),
);

it.effect("finalizes ambiguity after the bounded reconciliation recovery lease expires", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "expired-reconciliation-recovery");
      const email = record(seeded, "expired-reconciliation-recovery");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "failure",
        "ambiguous",
        null,
        "send-outcome-unknown",
        new Date(sendAt.getTime() + 120_000),
      );
      const claimedAt = new Date(sendAt.getTime() + 241_000);
      const leaseExpiresAt = new Date(sendAt.getTime() + 301_000);
      yield* persistence.claimTerminalReconciliation(
        email.workflowId,
        email.inputDigest,
        claimedAt,
        leaseExpiresAt,
      );
      const recoveredAt = new Date(leaseExpiresAt.getTime() + 1);
      const recoveryDeadline = new Date(leaseExpiresAt.getTime() + 60_000);
      yield* persistence.claimTerminalReconciliation(
        email.workflowId,
        email.inputDigest,
        recoveredAt,
        new Date(recoveredAt.getTime() + 60_000),
      );

      expect(
        yield* persistence.finalizeAmbiguousAccounting(
          email.workflowId,
          email.inputDigest,
          recoveryDeadline,
        ),
      ).toMatchObject({ sendAccountingBasis: null });
      expect(
        yield* persistence.finalizeAmbiguousAccounting(
          email.workflowId,
          email.inputDigest,
          new Date(recoveryDeadline.getTime() + 1),
        ),
      ).toMatchObject({
        sendAccountingBasis: "conservative",
        sendReconciliationClaimedAt: null,
        sendReconciliationLeaseExpiresAt: null,
      });
    }),
  ),
);

it.effect("rejects NULL-hole pending and success lifecycle rows", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "constraint-null-holes");
      const email = record(seeded, "constraint-null-holes");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);

      expect(
        yield* Effect.tryPromise(() =>
          database
            .update(scheduledEmails)
            .set({ send_accounted_at: sendAt, state: "waiting" })
            .where(eq(scheduledEmails.workflow_id, email.workflowId)),
        ).pipe(Effect.result),
      ).toMatchObject({ failure: expect.anything() });
      expect(
        yield* Effect.tryPromise(() =>
          database
            .update(scheduledEmails)
            .set({
              send_outcome: null,
              send_outcome_at: null,
              state: "send_pending_reconciliation",
            })
            .where(eq(scheduledEmails.workflow_id, email.workflowId)),
        ).pipe(Effect.result),
      ).toMatchObject({ failure: expect.anything() });
      expect(
        yield* Effect.tryPromise(() =>
          database
            .update(scheduledEmails)
            .set({
              provider_log_id: null,
              provider_resource_id: null,
              send_outcome: null,
              send_outcome_at: sendAt,
              state: "success",
              terminal_at: sendAt,
            })
            .where(eq(scheduledEmails.workflow_id, email.workflowId)),
        ).pipe(Effect.result),
      ).toMatchObject({ failure: expect.anything() });
      expect(
        yield* Effect.tryPromise(() =>
          database
            .update(scheduledEmails)
            .set({
              send_outcome: "ambiguous",
              send_outcome_at: sendAt,
              state: "canceled",
              terminal_at: sendAt,
            })
            .where(eq(scheduledEmails.workflow_id, email.workflowId)),
        ).pipe(Effect.result),
      ).toMatchObject({ failure: expect.anything() });
      expect(
        yield* Effect.tryPromise(() =>
          database
            .update(scheduledEmails)
            .set({
              provider_log_id: "contradictory-log",
              provider_resource_id: "contradictory-resource",
              send_outcome: "applied",
              send_outcome_at: sendAt,
              state: "failure",
              terminal_at: sendAt,
            })
            .where(eq(scheduledEmails.workflow_id, email.workflowId)),
        ).pipe(Effect.result),
      ).toMatchObject({ failure: expect.anything() });
    }),
  ),
);

it.effect(
  "records one observed fact when Applied evidence refines provisional terminal ambiguity",
  () =>
    withDatabase((database) =>
      Effect.gen(function* () {
        const seeded = yield* seedUser(database, "conservative-refinement");
        const email = record(seeded, "conservative-refinement");
        const persistence = ScheduledEmailPostgres.make(database);
        yield* persistence.admit(email, 5n);
        yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
        yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
        const unknown = yield* persistence.finishTerminal(
          email.workflowId,
          email.inputDigest,
          "failure",
          "ambiguous",
          null,
          "send-outcome-unknown",
          sendAt,
        );
        expect(unknown).toMatchObject({
          sendAccountedAt: null,
          sendAccountingBasis: null,
          sendOutcome: "ambiguous",
          state: "failure",
        });
        const followUps = ScheduledEmailFollowUpPostgres.make(database);
        const notificationId = ScheduledEmailFollowUp.NotificationId.make(
          `${email.workflowId}-terminal`,
        );
        yield* followUps.claimTerminal(unknown, notificationId, sendAt);
        yield* followUps.selectDeliverySession(notificationId, email.sessionId);
        yield* followUps.markAccepted(
          notificationId,
          ThinkSubmissionId.make("conservative-refinement-submission"),
          new Date("2026-08-28T12:00:01.000Z"),
        );

        const refined = yield* persistence.finishApplied(
          email.workflowId,
          email.inputDigest,
          applied,
          new Date("2026-08-28T12:00:02.000Z"),
        );
        expect(refined).toMatchObject({
          sendAccountingBasis: "observed",
          sendOutcome: "applied",
          state: "success",
        });
        yield* Effect.promise(() =>
          database.insert(allowanceUsage).values({
            allowance_kind: "gmailSends",
            allowance_period_id: email.allowancePeriodId,
            basis: "observed",
            quantity: 1n,
            source_id: email.actionId,
            source_type: "integrationAction",
            user_id: email.userId,
          }),
        );
        yield* persistence.markSendAccounted(
          email.workflowId,
          email.inputDigest,
          new Date("2026-08-28T12:00:03.000Z"),
        );
        expect(yield* followUps.inspect(notificationId)).toMatchObject({
          sendOutcome: "ambiguous",
          state: "failure",
          workflowId: email.workflowId,
        });
        expect(yield* followUps.deliveredForUser(email.userId)).toMatchObject([
          { sendOutcome: "applied", state: "success", workflowId: email.workflowId },
        ]);
        expect(
          yield* Effect.promise(() =>
            database
              .select({
                basis: allowanceUsage.basis,
                periodId: allowanceUsage.allowance_period_id,
                sourceId: allowanceUsage.source_id,
              })
              .from(allowanceUsage)
              .where(eq(allowanceUsage.source_id, email.actionId)),
          ),
        ).toEqual([
          {
            basis: "observed",
            periodId: email.allowancePeriodId,
            sourceId: email.actionId,
          },
        ]);
      }),
    ),
);

it.effect("resolves late NotApplied accounting without an immutable Gmail fact", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "not-applied-refinement");
      const persistence = ScheduledEmailPostgres.make(database);
      const followUps = ScheduledEmailFollowUpPostgres.make(database);
      const email = record(seeded, "not-applied-late");
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      const unknown = yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "failure",
        "ambiguous",
        null,
        "send-outcome-unknown",
        new Date(sendAt.getTime() + 120_000),
      );
      const notificationId = ScheduledEmailFollowUp.NotificationId.make(
        `${email.workflowId}-terminal`,
      );
      yield* followUps.claimTerminal(unknown, notificationId, sendAt);
      yield* followUps.selectDeliverySession(notificationId, email.sessionId);
      yield* followUps.markAccepted(
        notificationId,
        ThinkSubmissionId.make("not-applied-late-submission"),
        sendAt,
      );

      const refined = yield* persistence.refineNotApplied(
        email.workflowId,
        email.inputDigest,
        "proved-not-applied-late",
        new Date(sendAt.getTime() + 240_000),
      );
      expect(refined).toMatchObject({
        providerLogId: "proved-not-applied-late",
        safeFailureCode: "send-not-applied",
        sendAccountedAt: null,
        sendAccountingBasis: null,
        sendOutcome: "notApplied",
        state: "failure",
      });
      expect(
        (yield* ScheduledEmailPostgres.reconciliationBatch(
          database,
          new Date(sendAt.getTime() + 241_000),
          20,
        )).some(({ workflowId }) => workflowId === email.workflowId),
      ).toBe(true);

      yield* persistence.markSendAccounted(
        email.workflowId,
        email.inputDigest,
        new Date(sendAt.getTime() + 242_000),
      );
      expect(yield* persistence.inspect(email.workflowId)).toMatchObject({
        sendAccountedAt: expect.any(Date),
        sendAccountingBasis: null,
        sendOutcome: "notApplied",
      });
      expect(
        yield* Effect.promise(() =>
          database
            .select({ basis: allowanceUsage.basis })
            .from(allowanceUsage)
            .where(eq(allowanceUsage.source_id, email.actionId)),
        ),
      ).toEqual([]);
      expect(yield* followUps.inspect(notificationId)).toMatchObject({
        sendOutcome: "ambiguous",
        state: "failure",
      });
      expect(yield* followUps.deliveredForUser(email.userId)).toMatchObject([
        { sendOutcome: "notApplied", state: "failure", workflowId: email.workflowId },
      ]);
    }),
  ),
);

it.effect("selects pre-wait hosts and post-commit obligations for minute repair", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "durable-obligations");
      const persistence = ScheduledEmailPostgres.make(database);
      const accepted = record(seeded, "accepted-host");
      const terminalInput = record(seeded, "terminal-obligation");
      yield* persistence.admit(accepted, 5n);
      yield* persistence.admit(terminalInput, 5n);
      yield* persistence.markWaiting(
        terminalInput.workflowId,
        terminalInput.inputDigest,
        admittedAt,
      );
      yield* persistence.beginSend(terminalInput.workflowId, terminalInput.inputDigest, sendAt);
      yield* persistence.finishApplied(
        terminalInput.workflowId,
        terminalInput.inputDigest,
        applied,
        sendAt,
      );

      const candidates = yield* ScheduledEmailPostgres.reconciliationBatch(
        database,
        new Date("2026-08-28T12:01:00.000Z"),
        20,
      );
      expect(candidates).toContainEqual(
        expect.objectContaining({ kind: "host", workflowId: accepted.workflowId }),
      );
      expect(candidates).toContainEqual(
        expect.objectContaining({ kind: "settlement", workflowId: terminalInput.workflowId }),
      );
    }),
  ),
);

it.effect(
  "repairs durable host and send obligations through the public minute scheduled event",
  () =>
    withDatabase((database) =>
      Effect.gen(function* () {
        const seeded = yield* seedUser(database, "public-minute-boundary");
        const persistence = ScheduledEmailPostgres.make(database);
        const acceptedInput = record(seeded, "public-host");
        const accepted = {
          ...acceptedInput,
          cloudflareInstanceId: yield* ScheduledEmail.cloudflareInstanceIdFor(
            acceptedInput.workflowId,
          ),
        };
        const claimedInputCandidate = record(seeded, "public-send");
        const claimedInput = {
          ...claimedInputCandidate,
          cloudflareInstanceId: yield* ScheduledEmail.cloudflareInstanceIdFor(
            claimedInputCandidate.workflowId,
          ),
        };
        yield* persistence.admit(accepted, 5n);
        yield* persistence.admit(claimedInput, 5n);
        yield* persistence.markWaiting(
          claimedInput.workflowId,
          claimedInput.inputDigest,
          admittedAt,
        );
        yield* persistence.beginSend(claimedInput.workflowId, claimedInput.inputDigest, sendAt);

        let workflowCreates = 0;
        let providerInspections = 0;
        const followUps = ScheduledEmailFollowUpPostgres.make(database);
        const loadCurrentAuthorization = ScheduledEmailPostgres.makeCurrentAuthorization(database);
        const port = ScheduledEmail.Port.of({
          commitTerminalFollowUp: (email) =>
            Effect.gen(function* () {
              const notificationId = ScheduledEmailFollowUp.NotificationId.make(
                `${email.workflowId}-terminal`,
              );
              const claim = yield* followUps.claimTerminal(email, notificationId, sendAt);
              if (claim._tag !== "Claimed") return;
              yield* followUps.selectDeliverySession(notificationId, email.sessionId);
              const submissionId = yield* ScheduledEmailFollowUp.submissionIdFor(notificationId);
              yield* followUps.markAccepted(notificationId, submissionId, sendAt);
              yield* followUps.markWakeRequested(notificationId, sendAt);
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ScheduledEmail.Unavailable({
                    cause,
                    message: "Public journey follow-up failed",
                    operation: "journey.followUp",
                  }),
              ),
            ),
          currentAuthorization: (email, authority) =>
            loadCurrentAuthorization(email, authority).pipe(
              Effect.map((current) => ({
                ...current,
                authority:
                  authority === "durableTrigger"
                    ? {
                        _tag: "DurableTrigger" as const,
                        triggerId: email.workflowId,
                        triggerType: "workflow" as const,
                        userId: email.userId,
                      }
                    : current.authority,
                originatingAuthority:
                  authority === "durableTrigger"
                    ? {
                        _tag: "DurableTrigger" as const,
                        triggerId: email.workflowId,
                        triggerType: "workflow" as const,
                      }
                    : current.originatingAuthority,
                subscription: { ...current.subscription, plan: "adventurer" as const },
              })),
            ),
          persistence,
          reconcileSend: () =>
            Effect.sync(() => {
              providerInspections += 1;
              return { _tag: "Applied" as const, result: applied };
            }),
          recordSendOutcome: () => Effect.void,
          recordWorkflowStart: () => Effect.void,
          send: () => Effect.die(new Error("Public repair must not send again")),
          workflow: {
            create: () =>
              Effect.sync(() => {
                workflowCreates += 1;
              }),
            terminate: () => Effect.void,
          },
        });
        const serviceLayer = ScheduledEmail.layerWithoutDependencies.pipe(
          Layer.provide(Layer.succeed(ScheduledEmail.Port, port)),
        );
        const targetWorkflowIds = new Set([accepted.workflowId, claimedInput.workflowId]);
        const run = async (method: "begin" | "execute" | "recover", encoded: unknown) => {
          const payload = await Schema.decodeUnknownPromise(ScheduledEmail.WorkflowPayload)(
            encoded,
          );
          if (!targetWorkflowIds.has(payload.workflowId)) return { state: "canceled" as const };
          if (method === "execute") {
            throw new Error("Public repair target must not start a new send");
          }
          return Effect.runPromise(
            ScheduledEmail.Service.pipe(
              Effect.flatMap((emails) =>
                method === "begin" ? emails.beginWaiting(payload) : emails.recoverClaimed(payload),
              ),
              Effect.map((email) => ({ state: email.state })),
              Effect.provide(serviceLayer),
            ),
          );
        };
        const originalDirectory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
        const directory = new Proxy(originalDirectory, {
          get: (target, property, receiver) => {
            if (property === "beginScheduledEmail") {
              return (encoded: unknown) => run("begin", encoded);
            }
            if (property === "executeScheduledEmail") {
              return (encoded: unknown) => run("execute", encoded);
            }
            if (property === "recoverScheduledEmail") {
              return (encoded: unknown) => run("recover", encoded);
            }
            return Reflect.get(target, property, receiver);
          },
        });
        const namespace = new Proxy(env.OSFO_DIRECTORY, {
          get: (target, property, receiver) =>
            property === "getByName" ? () => directory : Reflect.get(target, property, receiver),
        });
        const context = createExecutionContext();
        worker.scheduled(
          createScheduledController({ cron: "* * * * *" }),
          { ...env, OSFO_DIRECTORY: namespace },
          context,
        );
        yield* Effect.promise(() => waitOnExecutionContext(context));

        expect(yield* persistence.inspect(accepted.workflowId)).toMatchObject({
          state: "waiting",
          workflowStartAccountedAt: expect.any(Date),
        });
        expect(yield* persistence.inspect(claimedInput.workflowId)).toMatchObject({
          sendAccountedAt: expect.any(Date),
          state: "success",
        });
        const notification = yield* followUps.inspect(
          ScheduledEmailFollowUp.NotificationId.make(`${claimedInput.workflowId}-terminal`),
        );
        expect(notification).toMatchObject({
          acceptedAt: expect.any(Date),
          state: "success",
          wakeRequestedAt: expect.any(Date),
        });
        expect(workflowCreates).toBe(1);
        expect(providerInspections).toBe(1);
      }),
    ),
);

it.effect("continues claimed reconciliation after deletion fencing and unblocks quiescence", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "fenced-recovery");
      const claimedCandidate = record(seeded, "fenced-claimed");
      const claimed = {
        ...claimedCandidate,
        cloudflareInstanceId: yield* ScheduledEmail.cloudflareInstanceIdFor(
          claimedCandidate.workflowId,
        ),
      };
      const due = record(seeded, "fenced-due");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* TestClock.setTime(sendAt.getTime());
      yield* persistence.admit(claimed, 5n);
      yield* persistence.markWaiting(claimed.workflowId, claimed.inputDigest, admittedAt);
      yield* persistence.beginSend(claimed.workflowId, claimed.inputDigest, sendAt);
      yield* persistence.admit(due, 5n);
      yield* persistence.markWaiting(due.workflowId, due.inputDigest, admittedAt);
      yield* insertDeletionFence(database, seeded, "fenced-recovery");

      const terminated = new Array<string>();
      const bindings = deletionBindings(terminated);
      const { SCHEDULED_EMAIL_WORKFLOW: omittedScheduledEmailWorkflow, ...missingBindings } =
        bindings;
      expect(omittedScheduledEmailWorkflow).toBeDefined();
      const missingScheduled = yield* quiesceWorkflows(
        missingBindings,
        database,
        seeded.userId,
      ).pipe(Effect.result);
      expect(missingScheduled).toMatchObject({
        failure: { operation: "quiesceWorkflows" },
      });
      const firstQuiescence = yield* quiesceWorkflows(bindings, database, seeded.userId).pipe(
        Effect.result,
      );
      expect(Result.isFailure(firstQuiescence)).toBe(true);
      if (Result.isFailure(firstQuiescence)) {
        expect(firstQuiescence.failure.message).toBe(
          "A claimed Scheduled Email send is still reconciling",
        );
        expect(firstQuiescence.failure.operation).toBe("quiesceWorkflows");
      }
      expect(terminated).toContain(due.cloudflareInstanceId);
      const candidates = yield* ScheduledEmailPostgres.reconciliationBatch(
        database,
        new Date("2026-08-28T12:01:00.000Z"),
        20,
      );
      expect(candidates).toContainEqual(
        expect.objectContaining({ kind: "claimed", workflowId: claimed.workflowId }),
      );
      expect(candidates.some(({ workflowId }) => workflowId === due.workflowId)).toBe(false);

      let providerCalls = 0;
      const port = ScheduledEmail.Port.of({
        commitTerminalFollowUp: () => Effect.void,
        currentAuthorization: ScheduledEmailPostgres.makeCurrentAuthorization(database),
        persistence,
        reconcileSend: () => Effect.succeed({ _tag: "NotStarted" }),
        recordSendOutcome: () => Effect.void,
        recordWorkflowStart: () => Effect.void,
        send: (_email, authorize) =>
          authorize.pipe(
            Effect.andThen(
              Effect.sync(() => {
                providerCalls += 1;
                return applied;
              }),
            ),
          ),
        workflow: { create: () => Effect.void, terminate: () => Effect.void },
      });
      const recovered = yield* ScheduledEmail.Service.pipe(
        Effect.flatMap((emails) => emails.recoverClaimed(payloadFor(claimed))),
        Effect.provide(
          ScheduledEmail.layerWithoutDependencies.pipe(
            Layer.provide(Layer.succeed(ScheduledEmail.Port, port)),
          ),
        ),
      );
      expect(recovered).toMatchObject({ safeFailureCode: "authority-ended", state: "canceled" });
      expect(providerCalls).toBe(0);
      expect(
        yield* ScheduledEmailPostgres.quiesceForAccountDeletion(database, seeded.userId, sendAt),
      ).toMatchObject({ _tag: "Ready" });
    }),
  ),
);

it.effect("retargets terminal delivery before acceptance and fences every later write", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "follow-up-locking");
      const email = record(seeded, "follow-up-locking");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      const terminal = yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "failure",
        "notApplied",
        "gmail-rejected-log",
        "send-not-applied",
        sendAt,
      );
      const followUps = ScheduledEmailFollowUpPostgres.make(database);
      const notificationId = ScheduledEmailFollowUp.NotificationId.make(
        `${email.workflowId}-terminal`,
      );
      expect(yield* followUps.claimTerminal(terminal, notificationId, sendAt)).toMatchObject({
        _tag: "Claimed",
      });
      expect(
        (yield* followUps.selectDeliverySession(notificationId, SessionId.make("first-session")))
          .deliverySessionId,
      ).toBe("first-session");
      expect(
        (yield* followUps.selectDeliverySession(notificationId, SessionId.make("current-session")))
          .deliverySessionId,
      ).toBe("current-session");
      yield* followUps.markAccepted(
        notificationId,
        ThinkSubmissionId.make("scheduled-email-terminal-submission"),
        sendAt,
      );
      expect(
        yield* followUps
          .selectDeliverySession(notificationId, SessionId.make("too-late-session"))
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "ScheduledEmailFollowUpUnavailable" } });
      yield* insertDeletionFence(database, seeded, "follow-up-locking");
      expect(
        yield* followUps
          .markAccepted(
            notificationId,
            ThinkSubmissionId.make("scheduled-email-terminal-submission"),
            sendAt,
          )
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "ScheduledEmailFollowUpUnavailable" } });
      expect(
        yield* followUps.markWakeRequested(notificationId, sendAt).pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "ScheduledEmailFollowUpUnavailable" } });
    }),
  ),
);

it.effect("retains one exact WhatsApp terminal source and rejects revoked or deleted links", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "whatsapp-source");
      const channelLinkId = ChannelLinkId.make("scheduled-email-whatsapp-source");
      yield* Effect.promise(() =>
        database.insert(channelLinks).values({
          author_id: "whatsapp-source-author",
          channel_id: "whatsapp",
          channel_link_id: channelLinkId,
          user_id: seeded.userId,
        }),
      );
      const email = {
        ...record(seeded, "whatsapp-source"),
        originatingAuthority: { _tag: "ChannelLink" as const, channelLinkId },
      };
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      const terminal = yield* persistence.finishApplied(
        email.workflowId,
        email.inputDigest,
        applied,
        sendAt,
      );
      const followUps = ScheduledEmailFollowUpPostgres.make(database);
      const notificationId = ScheduledEmailFollowUp.NotificationId.make(
        `${email.workflowId}-terminal`,
      );
      const firstClaim = yield* followUps.claimTerminal(terminal, notificationId, sendAt);
      const replayedClaim = yield* followUps.claimTerminal(terminal, notificationId, sendAt);
      expect(firstClaim).toEqual(replayedClaim);
      expect(firstClaim).toMatchObject({
        _tag: "Claimed",
        notification: { whatsAppChannelLinkId: channelLinkId },
      });
      const submissionId = ThinkSubmissionId.make("scheduled-email-whatsapp-submission");
      const accepted = yield* followUps.markAccepted(notificationId, submissionId, sendAt);
      expect(yield* followUps.markAccepted(notificationId, submissionId, sendAt)).toEqual(accepted);
      yield* persistence.markWorkflowStartAccounted(email.workflowId, email.inputDigest, sendAt);
      yield* persistence.markSendAccounted(email.workflowId, email.inputDigest, sendAt);
      expect(
        yield* ScheduledEmailPostgres.reconciliationBatch(database, sendAt, 20),
      ).toContainEqual(expect.objectContaining({ workflowId: email.workflowId }));
      const wakeRequested = yield* followUps.markWakeRequested(notificationId, sendAt);
      expect(wakeRequested.wakeRequestedAt).toEqual(sendAt);
      expect(yield* followUps.markWakeRequested(notificationId, sendAt)).toEqual(wakeRequested);
      expect(
        (yield* ScheduledEmailPostgres.reconciliationBatch(database, sendAt, 20)).some(
          ({ workflowId }) => workflowId === email.workflowId,
        ),
      ).toBe(false);

      const source = WhatsAppWakeUps.Source.cases.ScheduledEmail.make({
        identity: WhatsAppWakeUps.SourceIdentity.make(notificationId),
      });
      const authority = scheduledEmailSourceAuthority(database);
      const retained = yield* authority.inspect(seeded.userId, source);
      expect(retained).toEqual({ committedAt: sendAt, source });
      expect(yield* authority.inspect(seeded.userId, source)).toEqual(retained);

      yield* Effect.promise(() =>
        database
          .update(channelLinks)
          .set({
            revocation_reason: "User disconnected WhatsApp",
            revoked_at: sendAt,
            revoked_by: `user:${seeded.userId}`,
          })
          .where(eq(channelLinks.channel_link_id, channelLinkId)),
      );
      expect(yield* authority.inspect(seeded.userId, source)).toBeNull();
      expect(yield* authority.pendingForUser(seeded.userId)).toEqual([]);
      yield* Effect.promise(() =>
        database.delete(channelLinks).where(eq(channelLinks.channel_link_id, channelLinkId)),
      );
      expect(yield* authority.inspect(seeded.userId, source)).toBeNull();
    }),
  ),
);

it.effect(
  "rotates a bounded reconciliation batch so the twenty-first claimed send is not starved",
  () =>
    withDatabase((database) =>
      Effect.gen(function* () {
        const seeded = yield* seedUser(database, "repair-fairness");
        const persistence = ScheduledEmailPostgres.make(database);
        const emails = Array.from({ length: 21 }, (_, index) =>
          record(seeded, `repair-fairness-${index + 1}`),
        );
        for (const [index, email] of emails.entries()) {
          yield* persistence.admit(email, 30n);
          yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
          yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
          yield* Effect.promise(() =>
            database
              .update(scheduledEmails)
              .set({ updated_at: new Date(`2026-08-27T${String(index).padStart(2, "0")}:00:00Z`) })
              .where(eq(scheduledEmails.workflow_id, email.workflowId)),
          );
        }
        const first = yield* ScheduledEmailPostgres.reconciliationBatch(
          database,
          new Date("2026-08-28T12:01:00.000Z"),
          20,
        );
        const second = yield* ScheduledEmailPostgres.reconciliationBatch(
          database,
          new Date("2026-08-28T12:02:00.000Z"),
          20,
        );
        expect(first).toHaveLength(20);
        expect(first.some(({ workflowId }) => workflowId === emails[20]?.workflowId)).toBe(false);
        expect(second.some(({ workflowId }) => workflowId === emails[20]?.workflowId)).toBe(true);
        const workflowIds = new Set(emails.map(({ workflowId }) => workflowId));
        expect(
          second
            .filter(({ workflowId }) => workflowIds.has(workflowId))
            .every(({ kind }) => kind === "claimed"),
        ).toBe(true);
      }),
    ),
);

interface SeededUser {
  readonly agentId: AgentId;
  readonly allowancePeriodId: AllowancePeriodId;
  readonly authSessionId: AuthSessionId;
  readonly userId: UserId;
}

const withDatabase = <Value, Failure>(use: (database: Database) => Effect.Effect<Value, Failure>) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => postgres(env.DB.connectionString, { max: 4, prepare: false })),
      (client) => Effect.promise(() => client.end({ timeout: 0 })),
    ).pipe(Effect.map(createDb), Effect.flatMap(use)),
  );

const seedUser = (database: Database, identity: string) => {
  const seeded = {
    agentId: AgentId.make(`scheduled-email-agent-${identity}`),
    allowancePeriodId: AllowancePeriodId.make(`scheduled-email-period-${identity}`),
    authSessionId: AuthSessionId.make(`scheduled-email-auth-${identity}`),
    userId: UserId.make(`scheduled-email-user-${identity}`),
  };
  return Effect.gen(function* () {
    yield* Effect.promise(() =>
      database.insert(users).values({
        email: `${identity}@example.test`,
        emailVerified: true,
        id: seeded.userId,
        name: "Scheduled Email",
      }),
    );
    yield* Effect.promise(() =>
      database.insert(billingSubscriptions).values({
        billing_subscription_id: `scheduled-email-subscription-${identity}`,
        plan: "free",
        plan_policy_version: "launch-v1",
        user_id: seeded.userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(allowancePeriods).values({
        allowance_period_id: seeded.allowancePeriodId,
        billing_subscription_id: `scheduled-email-subscription-${identity}`,
        ends_at: new Date("2027-08-28T12:00:00.000Z"),
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: new Date("2026-01-01T00:00:00.000Z"),
        user_id: seeded.userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(agents).values({
        agent_id: seeded.agentId,
        created_at: admittedAt.toISOString(),
        user_id: seeded.userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(sessions).values({
        expiresAt: new Date("2027-08-28T12:00:00.000Z"),
        id: seeded.authSessionId,
        token: `scheduled-email-token-${identity}`,
        updatedAt: admittedAt,
        userId: seeded.userId,
      }),
    );
    return seeded;
  });
};

const record = (seeded: SeededUser, identity: string) =>
  makeRecord({
    acceptedAt: admittedAt,
    actionId: ActionId.make(`scheduled-email-action-${identity}`),
    admittedAt,
    agentId: seeded.agentId,
    allowancePeriodId: seeded.allowancePeriodId,
    cloudflareInstanceId: ScheduledEmail.CloudflareInstanceId.make(`scheduled-email-${identity}`),
    dueAt,
    inputDigest: ScheduledEmail.InputDigest.make(
      identity
        .split("")
        .reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0)
        .toString(16)
        .padStart(64, "0")
        .slice(-64),
    ),
    originatingAuthority: { _tag: "AuthSession", authSessionId: seeded.authSessionId },
    plan: "free",
    request: ScheduledEmail.Request.make({
      body: `Body ${identity}`,
      gmailResource: "primary",
      recipients: [`${identity}@example.test`],
      scheduledAt: dueAt,
      subject: `Subject ${identity}`,
    }),
    state: "accepted",
    userId: seeded.userId,
    workflowId: ScheduledEmail.WorkflowId.make(`scheduled-email:${identity}`),
  });

const payloadFor = (email: ScheduledEmail.Record) =>
  ScheduledEmail.WorkflowPayload.make({
    agentId: email.agentId,
    dueAt: email.dueAt,
    inputDigest: email.inputDigest,
    workflowId: email.workflowId,
  });

const insertDeletionFence = (database: Database, seeded: SeededUser, identity: string) =>
  Effect.promise(() =>
    database.insert(deletionCases).values({
      access_fenced_at: sendAt,
      approval_action_id: `delete-action-${identity}`,
      approval_presentation: "Delete Account",
      deletion_case_id: `delete-case-${identity}`,
      reason: "User requested account deletion",
      requested_by_user_id: seeded.userId,
      user_id: seeded.userId,
    }),
  );

const researchRow = (seeded: SeededUser, identity: string) => ({
  action_id: `research-action-${identity}`,
  admitted_at: admittedAt,
  agent_id: seeded.agentId,
  allowance_period_id: seeded.allowancePeriodId,
  capability_catalog_version: "capability-catalog-v1",
  cloudflare_instance_id: `research-${identity}`,
  deadline_at: dueAt,
  input_digest: "1".repeat(64),
  model_access_policy_version: "launch-v1",
  model_route: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  originating_authority_json: JSON.stringify({
    _tag: "AuthSession",
    authSessionId: seeded.authSessionId,
  }),
  plan_policy_version: "launch-v1",
  request_json: JSON.stringify({ topic: identity }),
  resource_price_version: "resource-prices-v1",
  route_id: "scheduled-email-route",
  session_id: "scheduled-email-session",
  state: "admitted" as const,
  user_id: seeded.userId,
  workflow_id: `research:${identity}`,
});

const documentRow = (seeded: SeededUser, identity: string) => ({
  action_id: `document-action-${identity}`,
  admitted_at: admittedAt,
  agent_id: seeded.agentId,
  allowance_period_id: seeded.allowancePeriodId,
  capability_catalog_version: "capability-catalog-v1",
  cloudflare_instance_id: `document-${identity}-main`,
  cloudflare_timer_instance_id: `document-${identity}-timer`,
  deadline_at: dueAt,
  input_digest: "2".repeat(64),
  model_access_policy_version: "launch-v1",
  model_route: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  originating_authority_json: JSON.stringify({
    _tag: "AuthSession",
    authSessionId: seeded.authSessionId,
  }),
  plan_policy_version: "launch-v1",
  request_json: JSON.stringify({ description: identity, format: "pdf", title: identity }),
  resource_price_version: "resource-prices-v1",
  route_id: "scheduled-email-route",
  session_id: "scheduled-email-session",
  state: "admitted" as const,
  user_id: seeded.userId,
  workflow_id: `document:${identity}`,
});

const applied: IntegrationEffectCompleted = {
  _tag: "IntegrationEffectCompleted" as const,
  evidence: { providerLogId: "gmail-log", providerResourceId: "gmail-message" },
  manifestVersion: ManifestVersion.make("gmail-v1"),
  mutations: 1 as const,
  operation: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
};

const deletionBindings = (terminated: Array<string>): Bindings => {
  const binding = {
    create: async () => ({
      restart: async () => undefined,
      status: async () => ({ status: "running" as const }),
      terminate: async () => undefined,
    }),
    get: async (id: string) => ({
      restart: async () => undefined,
      status: async () => ({ status: "running" as const }),
      terminate: async () => {
        terminated.push(id);
      },
    }),
  };
  return {
    DOCUMENT_BUILD_TIMER_WORKFLOW: binding,
    DOCUMENT_BUILD_WORKFLOW: binding,
    integrationAuthorityDeletion: { _tag: "NotDelivered" },
    OSFO_DIRECTORY: {
      getByName: () => ({
        deleteAgent: async () => undefined,
        quiesceAgentAccountDeletion: async () => undefined,
      }),
    },
    RESEARCH_REPORT_TIMER_WORKFLOW: binding,
    RESEARCH_REPORT_WORKFLOW: binding,
    SCHEDULED_EMAIL_WORKFLOW: binding,
  };
};
