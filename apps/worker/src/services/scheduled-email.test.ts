/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed authority fixtures prove exact schedule behavior. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect owns its isolated service Layer. */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import {
  AgentId,
  AllowancePeriodId,
  ConversationRouteId,
  ManifestVersion,
  PlanPolicyVersion,
  SessionId,
  UserId,
} from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import {
  approvalFor,
  ApprovalPresentation,
  emptyLiveResourceFacts,
  type AuthorizationContext,
} from "./authorization";
import type { IntegrationEffectCompleted } from "./integrations";
import { ScheduledEmail } from "./scheduled-email";

const now = new Date("2026-08-28T12:00:00.000Z");
const scheduledAt = new Date("2026-08-28T12:05:00.000Z");
const periodEndsAt = new Date("2026-09-28T12:00:00.000Z");
const userId = UserId.make("scheduled-email-user");
const agentId = AgentId.make("scheduled-email-agent");
const routeId = ConversationRouteId.make("scheduled-email-route");
const sessionId = SessionId.make("scheduled-email-session");
const actionId = ActionId.make("scheduled-email-action");
const request = ScheduledEmail.Request.make({
  body: "Exact scheduled body",
  gmailResource: "primary",
  recipients: ["recipient@example.test"],
  scheduledAt,
  subject: "Exact scheduled subject",
});
const presentation = ApprovalPresentation.make(
  JSON.stringify({
    body: request.body,
    gmailResource: request.gmailResource,
    recipients: request.recipients,
    scheduledAt: scheduledAt.toISOString(),
    subject: request.subject,
  }),
);

describe("ScheduledEmail", () => {
  it.effect("binds stable Workflow identity to exact content, Gmail resource, and schedule", () =>
    Effect.gen(function* () {
      const first = yield* ScheduledEmail.workflowIdFor(userId, actionId);
      const replay = yield* ScheduledEmail.workflowIdFor(userId, actionId);
      const changedAction = yield* ScheduledEmail.workflowIdFor(
        userId,
        ActionId.make("another-action"),
      );

      expect(replay).toBe(first);
      expect(changedAction).not.toBe(first);
      const digest = yield* ScheduledEmail.digestRequest(userId, request);
      const changedSchedule = yield* ScheduledEmail.digestRequest(
        userId,
        ScheduledEmail.Request.make({
          ...request,
          scheduledAt: new Date("2026-08-28T12:06:00.000Z"),
        }),
      );
      expect(changedSchedule).not.toBe(digest);
      expect(presentation).toContain(scheduledAt.toISOString());
    }),
  );

  it.effect("persists before Workflow create and replays only the exact request", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const replayed = yield* emails.start(startInput());
      const changed = yield* emails
        .start(
          startInput({
            request: ScheduledEmail.Request.make({ ...request, subject: "Changed subject" }),
          }),
        )
        .pipe(Effect.result);

      expect(started).toMatchObject({ _tag: "Started", email: { state: "accepted" } });
      expect(replayed).toMatchObject({ _tag: "Replayed", email: { state: "accepted" } });
      expect(changed).toMatchObject({ failure: { _tag: "ScheduledEmailConflict" } });
      expect(fixture.calls.slice(0, 4)).toEqual([
        "persist.admit",
        "workflow.create",
        "persist.accept",
        "account.workflowStart",
      ]);
      expect(fixture.instances).toHaveLength(1);
      expect(
        yield* emails
          .beginWaiting({
            ...payloadFor(started.email),
            agentId: AgentId.make("different-agent"),
          })
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "ScheduledEmailConflict" } });
      expect(
        yield* emails
          .beginWaiting({
            ...payloadFor(started.email),
            dueAt: new Date(started.email.dueAt.getTime() + 60_000),
          })
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "ScheduledEmailConflict" } });
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("waits for the exact instant, rechecks Gmail authority, and sends once", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);

      const early = yield* emails.sendDue(payload).pipe(Effect.result);
      expect(early).toMatchObject({ failure: { _tag: "ScheduledEmailConflict" } });
      yield* TestClock.setTime(scheduledAt.getTime());
      const sent = yield* emails.sendDue(payload);
      const replayed = yield* emails.sendDue(payload);

      expect(sent).toMatchObject({ sendOutcome: "applied", state: "success" });
      expect(replayed).toMatchObject({ sendOutcome: "applied", state: "success" });
      expect(fixture.sendAttempts).toBe(1);
      expect(fixture.workflowStartFacts).toBe(1);
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.followUps).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("exposes each Scheduled Email SLO interval without terminalizing ambiguity", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime() + 30_000);
      const sent = yield* emails.sendDue(payload);
      const acceptedAt = new Date((sent.terminalAt?.getTime() ?? 0) + 30_000);
      expect(ScheduledEmail.sloEvidence(sent, acceptedAt)).toEqual({
        dueToSendClaimMilliseconds: 30_000,
        sendClaimToTerminalMilliseconds: 0,
        terminalToFollowUpAcceptedMilliseconds: 30_000,
      });
      const ambiguous = {
        ...sent,
        state: "send_pending_reconciliation" as const,
        terminalAt: null,
      };
      expect(ScheduledEmail.sloEvidence(ambiguous, null)).toMatchObject({
        sendClaimToTerminalMilliseconds: null,
        terminalToFollowUpAcceptedMilliseconds: null,
      });
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("ends without sending when live Gmail connection authority ends", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      fixture.currentAuthorization = {
        ...fixture.currentAuthorization,
        gmailConnection: null,
        integrationConnections: [],
      };
      yield* TestClock.setTime(scheduledAt.getTime());
      const canceled = yield* emails.sendDue(payload);

      expect(canceled).toMatchObject({ safeFailureCode: "authority-ended", state: "canceled" });
      expect(fixture.sendAttempts).toBe(0);
      expect(fixture.gmailSendFacts).toBe(0);
      expect(fixture.followUps).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("uses the durable Workflow trigger after the original AuthSession expires", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      fixture.currentAuthorization = {
        ...fixture.currentAuthorization,
        authority: {
          _tag: "RevokedAuthSession",
          authSessionId: AuthSessionId.make("scheduled-email-auth-session"),
          userId,
        },
      };
      yield* TestClock.setTime(scheduledAt.getTime());

      expect(yield* emails.sendDue(payload)).toMatchObject({ state: "success" });
      expect(fixture.sendAttempts).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("authorizes inspect and cancel from the current caller session", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const current: AuthorizationContext = {
        ...authorization(),
        authority: {
          _tag: "AuthSession",
          authSessionId: AuthSessionId.make("replacement-auth-session"),
          expiresAt: periodEndsAt,
          userId,
        },
        originatingAuthority: {
          _tag: "AuthSession",
          authSessionId: AuthSessionId.make("replacement-auth-session"),
        },
      };

      expect(yield* emails.inspect(started.email.workflowId, current)).toMatchObject({
        state: "accepted",
      });
      expect(yield* emails.cancel(started.email.workflowId, current)).toMatchObject({
        _tag: "CancelRequested",
        email: { state: "canceled" },
      });
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("keeps inspect and cancellation available without live Gmail evidence", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const current = {
        ...authorization(),
        gmailConnection: null,
        integrationConnections: [],
      } satisfies AuthorizationContext;

      expect(yield* emails.inspect(started.email.workflowId, current)).toMatchObject({
        state: "accepted",
      });
      expect(yield* emails.cancel(started.email.workflowId, current)).toMatchObject({
        _tag: "CancelRequested",
        email: { state: "canceled" },
      });
      expect(fixture.sendAttempts).toBe(0);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("terminalizes unresolved ambiguity after the bounded evidence window", () => {
    const fixture = makeFixture({ sendOutcome: "ambiguous" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      const unknown = yield* emails.sendDue(payload);
      const pending = yield* emails.sendDue(payload);

      expect(unknown).toMatchObject({ sendOutcome: null, state: "sending", terminalAt: null });
      expect(pending).toMatchObject({ sendOutcome: null, state: "sending", terminalAt: null });
      expect(fixture.gmailSendFacts).toBe(0);
      fixture.reconciliation = { _tag: "Ambiguous" };
      yield* TestClock.setTime(scheduledAt.getTime() + 120_000);
      const conservative = yield* emails.sendDue(payload);
      const replayed = yield* emails.sendDue(payload);

      expect(conservative).toMatchObject({
        safeFailureCode: "send-outcome-unknown",
        sendAccountingBasis: "conservative",
        sendOutcome: "ambiguous",
        state: "failure",
      });
      expect(conservative.terminalAt).not.toBeNull();
      expect(replayed).toMatchObject({
        sendAccountingBasis: "conservative",
        sendOutcome: "ambiguous",
        state: "failure",
      });
      expect(fixture.sendAttempts).toBe(1);
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.followUps).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect(
    "refines fully settled ambiguity to late Applied truth without another fact or follow-up",
    () => {
      const fixture = makeFixture({ sendOutcome: "ambiguous" });
      return Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        const emails = yield* ScheduledEmail.Service;
        const started = yield* emails.start(startInput());
        const payload = payloadFor(started.email);
        yield* emails.beginWaiting(payload);
        yield* TestClock.setTime(scheduledAt.getTime());
        yield* emails.sendDue(payload);
        fixture.reconciliation = { _tag: "Ambiguous" };
        yield* TestClock.setTime(scheduledAt.getTime() + 120_000);
        expect(yield* emails.recoverClaimed(payload)).toMatchObject({
          sendAccountedAt: expect.any(Date),
          sendOutcome: "ambiguous",
          state: "failure",
        });
        expect(fixture.gmailSendBases).toEqual(["conservative"]);
        expect(fixture.followUps).toBe(1);

        fixture.reconciliation = { _tag: "Applied", result: applied };
        yield* TestClock.setTime(scheduledAt.getTime() + 180_000);
        expect(yield* emails.recoverClaimed(payload)).toMatchObject({
          providerLogId: "gmail-log-1",
          providerResourceId: "gmail-message-1",
          sendAccountingBasis: "conservative",
          sendOutcome: "applied",
          state: "success",
        });
        expect(fixture.gmailSendBases).toEqual(["conservative"]);
        expect(fixture.followUps).toBe(1);
        expect(fixture.sendAttempts).toBe(1);
      }).pipe(Effect.provide(layer(fixture.port)));
    },
  );

  it.effect(
    "refines fully settled ambiguity to late NotApplied only within the evidence horizon",
    () => {
      const fixture = makeFixture({ sendOutcome: "ambiguous" });
      return Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        const emails = yield* ScheduledEmail.Service;
        const started = yield* emails.start(startInput());
        const payload = payloadFor(started.email);
        yield* emails.beginWaiting(payload);
        yield* TestClock.setTime(scheduledAt.getTime());
        yield* emails.sendDue(payload);
        fixture.reconciliation = { _tag: "Ambiguous" };
        yield* TestClock.setTime(scheduledAt.getTime() + 120_000);
        yield* emails.recoverClaimed(payload);
        fixture.reconciliation = {
          _tag: "NotApplied",
          providerLogId: "late-not-applied",
        };
        yield* TestClock.setTime(scheduledAt.getTime() + 240_000);
        expect(yield* emails.recoverClaimed(payload)).toMatchObject({
          providerLogId: "late-not-applied",
          safeFailureCode: "send-not-applied",
          sendAccountingBasis: "conservative",
          sendOutcome: "notApplied",
          state: "failure",
        });
        const attemptsWithinHorizon = fixture.reconciliationAttempts;
        yield* TestClock.setTime(scheduledAt.getTime() + 300_001);
        yield* emails.recoverClaimed(payload);
        expect(fixture.reconciliationAttempts).toBe(attemptsWithinHorizon);
        expect(fixture.gmailSendBases).toEqual(["conservative"]);
        expect(fixture.followUps).toBe(1);
        expect(fixture.sendAttempts).toBe(1);
      }).pipe(Effect.provide(layer(fixture.port)));
    },
  );

  it.effect("settles NotApplied evidence before conservative ambiguity accounting", () => {
    const fixture = makeFixture({ sendOutcome: "ambiguous" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      expect(yield* emails.sendDue(payload)).toMatchObject({ state: "sending" });
      fixture.reconciliation = {
        _tag: "NotApplied",
        providerLogId: "proved-not-applied-log",
      };

      const settled = yield* emails.sendDue(payload);
      expect(settled).toMatchObject({
        providerLogId: "proved-not-applied-log",
        sendOutcome: "notApplied",
        state: "failure",
      });
      expect(fixture.gmailSendFacts).toBe(0);
      expect(fixture.followUps).toBe(1);
      expect(fixture.sendAttempts).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("retries the same Action only when reconciliation proves no attempt started", () => {
    const fixture = makeFixture({ sendOutcome: "unavailable" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());

      expect(yield* emails.sendDue(payload).pipe(Effect.result)).toMatchObject({
        failure: { operation: "send.preclaim" },
      });
      expect(fixture.stored).toMatchObject({ sendOutcome: null, state: "sending" });
      fixture.reconciliation = { _tag: "NotStarted" };
      fixture.sendOutcome = "applied";

      expect(yield* emails.recoverClaimed(payload)).toMatchObject({ state: "success" });
      expect(fixture.sendAttempts).toBe(2);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("settles a proven NotApplied outcome without treating ambiguity as retryable", () => {
    const fixture = makeFixture({ sendOutcome: "notApplied" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      const failed = yield* emails.sendDue(payload);
      const replayed = yield* emails.sendDue(payload);

      expect(failed).toMatchObject({
        safeFailureCode: "send-not-applied",
        state: "failure",
      });
      expect(replayed).toMatchObject({ state: "failure" });
      expect(fixture.sendAttempts).toBe(1);
      expect(fixture.gmailSendFacts).toBe(0);
      expect(fixture.followUps).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect(
    "resumes the same Action through claimed recovery after a crash before Action retain",
    () => {
      const fixture = makeFixture();
      return Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        const emails = yield* ScheduledEmail.Service;
        const started = yield* emails.start(startInput());
        const payload = payloadFor(started.email);
        yield* emails.beginWaiting(payload);
        yield* TestClock.setTime(scheduledAt.getTime());
        yield* fixture.port.persistence.beginSend(
          started.email.workflowId,
          started.email.inputDigest,
          scheduledAt,
        );
        fixture.reconciliation = { _tag: "NotStarted" };

        const recovered = yield* emails.recoverClaimed(payload);
        expect(recovered).toMatchObject({ sendOutcome: "applied", state: "success" });
        expect(fixture.sendAttempts).toBe(1);
      }).pipe(Effect.provide(layer(fixture.port)));
    },
  );

  it.effect("honors cancellation before retrying a claim with no retained Action", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      yield* fixture.port.persistence.beginSend(
        started.email.workflowId,
        started.email.inputDigest,
        scheduledAt,
      );
      expect(yield* emails.cancel(started.email.workflowId, authorization())).toMatchObject({
        _tag: "ReconciliationRequired",
      });
      fixture.reconciliation = { _tag: "NotStarted" };

      expect(yield* emails.recoverClaimed(payload)).toMatchObject({
        safeFailureCode: "cancel-requested",
        state: "canceled",
      });
      expect(fixture.sendAttempts).toBe(0);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("reconciles ambiguous Applied truth despite a later cancellation request", () => {
    const fixture = makeFixture({ sendOutcome: "ambiguous" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      yield* emails.sendDue(payload);
      const cancellation = yield* emails.cancel(started.email.workflowId, authorization());
      expect(cancellation).toMatchObject({ _tag: "ReconciliationRequired" });
      fixture.reconciliation = { _tag: "Applied", result: applied };

      const reconciled = yield* emails.sendDue(payload);
      expect(reconciled).toMatchObject({ sendOutcome: "applied", state: "success" });
      expect(fixture.sendAttempts).toBe(1);
      expect(fixture.followUps).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("drains workflow-start accounting after acceptance committed before an outage", () => {
    const fixture = makeFixture();
    fixture.failWorkflowAccounting = true;
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      expect(yield* emails.start(startInput()).pipe(Effect.result)).toMatchObject({
        failure: { operation: "workflow-accounting" },
      });
      const retained = fixture.stored;
      expect(retained).toMatchObject({ state: "accepted", workflowStartAccountedAt: null });
      if (retained === null) throw new Error("accepted Scheduled Email was not retained");
      fixture.currentAuthorization = {
        ...fixture.currentAuthorization,
        authority: {
          _tag: "RevokedAuthSession",
          authSessionId: AuthSessionId.make("scheduled-email-auth-session"),
          userId,
        },
      };
      fixture.failWorkflowAccounting = false;
      const recovered = yield* emails.recoverClaimed(payloadFor(retained));
      expect(recovered).toMatchObject({ state: "waiting" });
      expect(recovered.workflowStartAccountedAt).not.toBeNull();
      expect(fixture.workflowStartFacts).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("cancels an admitted row when origin authority ends before acceptance", () => {
    const fixture = makeFixture();
    fixture.failWorkflowCreate = true;
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const pending = yield* emails.start(startInput());
      expect(pending).toMatchObject({ _tag: "AcceptancePending", email: { state: "admitted" } });
      fixture.failWorkflowCreate = false;
      fixture.currentAuthorization = {
        ...fixture.currentAuthorization,
        authority: {
          _tag: "RevokedAuthSession",
          authSessionId: AuthSessionId.make("scheduled-email-auth-session"),
          userId,
        },
      };

      const canceled = yield* emails.recoverClaimed(payloadFor(pending.email));
      expect(canceled).toMatchObject({
        safeFailureCode: "authority-ended-before-acceptance",
        state: "canceled",
      });
      expect(fixture.instances).toHaveLength(0);
      expect(fixture.sendAttempts).toBe(0);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("drains conservative ambiguity accounting after its state commit", () => {
    const fixture = makeFixture({ sendOutcome: "ambiguous" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      yield* emails.sendDue(payload);
      fixture.reconciliation = { _tag: "Ambiguous" };
      yield* TestClock.setTime(scheduledAt.getTime() + 120_000);
      fixture.failSendAccounting = true;
      expect(yield* emails.recoverClaimed(payload).pipe(Effect.result)).toMatchObject({
        failure: { operation: "send-accounting" },
      });
      expect(fixture.stored).toMatchObject({
        sendAccountedAt: null,
        sendAccountingBasis: "conservative",
        state: "failure",
      });
      fixture.failSendAccounting = false;
      const recovered = yield* emails.recoverClaimed(payload);
      expect(recovered.sendAccountedAt).not.toBeNull();
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.sendAttempts).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("refines unaccounted ambiguity when late evidence proves NotApplied", () => {
    const fixture = makeFixture({ sendOutcome: "ambiguous" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      yield* emails.sendDue(payload);
      fixture.reconciliation = { _tag: "Ambiguous" };
      yield* TestClock.setTime(scheduledAt.getTime() + 120_000);
      fixture.failSendAccounting = true;

      expect(yield* emails.recoverClaimed(payload).pipe(Effect.result)).toMatchObject({
        failure: { operation: "send-accounting" },
      });
      expect(fixture.stored).toMatchObject({
        sendAccountedAt: null,
        sendAccountingBasis: "conservative",
        sendOutcome: "ambiguous",
        state: "failure",
      });
      expect(fixture.gmailSendFacts).toBe(0);

      fixture.failSendAccounting = false;
      fixture.reconciliation = {
        _tag: "NotApplied",
        providerLogId: "late-proved-not-applied-log",
      };
      expect(yield* emails.recoverClaimed(payload)).toMatchObject({
        providerLogId: "late-proved-not-applied-log",
        safeFailureCode: "send-not-applied",
        sendAccountedAt: null,
        sendAccountingBasis: null,
        sendOutcome: "notApplied",
        state: "failure",
      });
      expect(fixture.gmailSendFacts).toBe(0);
      expect(fixture.followUps).toBe(1);
      expect(fixture.sendAttempts).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("preserves a conservative accounting decision when later evidence is Applied", () => {
    const fixture = makeFixture({ sendOutcome: "ambiguous" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      yield* emails.sendDue(payload);
      fixture.reconciliation = { _tag: "Ambiguous" };
      yield* TestClock.setTime(scheduledAt.getTime() + 120_000);
      fixture.failSendAccountingMarker = true;

      expect(yield* emails.recoverClaimed(payload).pipe(Effect.result)).toMatchObject({
        failure: { operation: "send-accounting-marker" },
      });
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.stored).toMatchObject({
        sendAccountedAt: null,
        sendAccountingBasis: "conservative",
        sendOutcome: "ambiguous",
        state: "failure",
      });

      fixture.failSendAccountingMarker = false;
      fixture.reconciliation = { _tag: "Applied", result: applied };
      expect(yield* emails.recoverClaimed(payload)).toMatchObject({
        sendAccountingBasis: "conservative",
        sendOutcome: "applied",
        state: "success",
      });
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.gmailSendBases).toEqual(["conservative"]);
      expect(fixture.followUps).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("keeps a retained conservative fact when later evidence proves NotApplied", () => {
    const fixture = makeFixture({ sendOutcome: "ambiguous" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      yield* emails.sendDue(payload);
      fixture.reconciliation = { _tag: "Ambiguous" };
      yield* TestClock.setTime(scheduledAt.getTime() + 120_000);
      fixture.failSendAccountingMarker = true;

      expect(yield* emails.recoverClaimed(payload).pipe(Effect.result)).toMatchObject({
        failure: { operation: "send-accounting-marker" },
      });
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.stored).toMatchObject({
        sendAccountedAt: null,
        sendAccountingBasis: "conservative",
        sendOutcome: "ambiguous",
      });

      fixture.failSendAccountingMarker = false;
      fixture.reconciliation = {
        _tag: "NotApplied",
        providerLogId: "late-not-applied-after-accounting",
      };
      expect(yield* emails.recoverClaimed(payload)).toMatchObject({
        providerLogId: "late-not-applied-after-accounting",
        safeFailureCode: "send-not-applied",
        sendAccountingBasis: "conservative",
        sendOutcome: "notApplied",
        state: "failure",
      });
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.gmailSendBases).toEqual(["conservative"]);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("drains terminal accounting and Always delivery after post-commit outages", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      const started = yield* emails.start(startInput());
      const payload = payloadFor(started.email);
      yield* emails.beginWaiting(payload);
      yield* TestClock.setTime(scheduledAt.getTime());
      fixture.failSendAccounting = true;
      expect(yield* emails.sendDue(payload).pipe(Effect.result)).toMatchObject({
        failure: { operation: "send-accounting" },
      });
      expect(fixture.stored).toMatchObject({ sendAccountedAt: null, state: "success" });
      fixture.failSendAccounting = false;
      fixture.failFollowUp = true;
      expect(yield* emails.recoverClaimed(payload).pipe(Effect.result)).toMatchObject({
        failure: { operation: "follow-up" },
      });
      expect(fixture.stored?.sendAccountedAt).not.toBeNull();
      fixture.failFollowUp = false;
      expect(yield* emails.recoverClaimed(payload)).toMatchObject({ state: "success" });
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.followUps).toBe(1);
      expect(fixture.sendAttempts).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });

  it.effect("drains an outstanding Workflow-start fact from terminal recovery", () => {
    const fixture = makeFixture();
    fixture.failWorkflowAccounting = true;
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const emails = yield* ScheduledEmail.Service;
      yield* emails.start(startInput()).pipe(Effect.result);
      const retained = fixture.stored;
      if (retained === null) throw new Error("accepted Scheduled Email was not retained");
      yield* fixture.port.persistence.markWaiting(retained.workflowId, retained.inputDigest, now);
      yield* fixture.port.persistence.beginSend(
        retained.workflowId,
        retained.inputDigest,
        scheduledAt,
      );
      const terminal = yield* fixture.port.persistence.finishApplied(
        retained.workflowId,
        retained.inputDigest,
        applied,
        scheduledAt,
      );
      fixture.failWorkflowAccounting = false;

      expect(yield* emails.recoverClaimed(payloadFor(terminal))).toMatchObject({
        state: "success",
      });
      expect(fixture.workflowStartFacts).toBe(1);
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.followUps).toBe(1);
    }).pipe(Effect.provide(layer(fixture.port)));
  });
});

const startInput = (overrides: Partial<ScheduledEmail.StartInput> = {}) => ({
  actionId,
  agentId,
  authorization: authorization(),
  request,
  routeId,
  sessionId,
  ...overrides,
});

const authorization = (): AuthorizationContext => ({
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("scheduled-email-period"),
    endsAt: periodEndsAt,
    plan: "adventurer",
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: now,
    usage: [],
  },
  approval: approvalFor(userId, ScheduledEmail.integrationOperation(actionId), presentation),
  authority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("scheduled-email-auth-session"),
    expiresAt: periodEndsAt,
    userId,
  },
  deletionAccess: { _tag: "DeletionAccessAvailable" },
  gmailConnection: { _tag: "Connected", toolkit: "gmail", userId },
  integrationConnections: [{ _tag: "Connected", toolkit: "gmail", userId }],
  liveFacts: emptyLiveResourceFacts,
  now,
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("scheduled-email-auth-session"),
  },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: userId,
  subscription: { plan: "adventurer", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
  user: { _tag: "ActiveUser", userId },
});

const applied: IntegrationEffectCompleted = {
  _tag: "IntegrationEffectCompleted",
  evidence: { providerLogId: "gmail-log-1", providerResourceId: "gmail-message-1" },
  manifestVersion: ManifestVersion.make("gmail-v1"),
  mutations: 1,
  operation: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
};

const makeFixture = (
  options: {
    readonly sendOutcome?: "ambiguous" | "applied" | "notApplied" | "unavailable";
  } = {},
) => {
  let stored: ScheduledEmail.Record | null = null;
  let workflowStartFacts = 0;
  let gmailSendFacts = 0;
  let followUps = 0;
  let sendAttempts = 0;
  let reconciliationAttempts = 0;
  let currentAuthorization = authorization();
  let reconciliation: ScheduledEmail.SendReconciliation = { _tag: "Pending" };
  let failWorkflowAccounting = false;
  let failWorkflowCreate = false;
  let failSendAccounting = false;
  let failSendAccountingMarker = false;
  let failFollowUp = false;
  let configuredSendOutcome = options.sendOutcome;
  const calls = new Array<string>();
  const instances = new Array<ScheduledEmail.CloudflareInstanceId>();
  const terminalFacts = new Map<ScheduledEmail.WorkflowId, "conservative" | "observed">();
  const workflowFacts = new Set<ScheduledEmail.WorkflowId>();
  const followUpFacts = new Set<ScheduledEmail.WorkflowId>();

  const sendResult = (): Effect.Effect<
    IntegrationEffectCompleted,
    ScheduledEmail.SendAmbiguous | ScheduledEmail.SendNotApplied | ScheduledEmail.Unavailable
  > => {
    sendAttempts += 1;
    if (configuredSendOutcome === "unavailable") return Effect.fail(unavailable("send.preclaim"));
    if (configuredSendOutcome === "ambiguous") {
      return Effect.fail(new ScheduledEmail.SendAmbiguous({ message: "unknown outcome" }));
    }
    if (configuredSendOutcome === "notApplied") {
      return Effect.fail(
        new ScheduledEmail.SendNotApplied({
          message: "provider rejected before applying",
          providerLogId: "gmail-rejected-log",
        }),
      );
    }
    return Effect.succeed(applied);
  };

  const requireStored = (
    workflowId: ScheduledEmail.WorkflowId,
    digest: ScheduledEmail.InputDigest,
  ) =>
    Effect.gen(function* () {
      if (stored === null) return yield* new ScheduledEmail.NotFound({ workflowId });
      if (stored.inputDigest !== digest) {
        return yield* new ScheduledEmail.Conflict({ message: "changed input", workflowId });
      }
      return stored;
    });

  const port = ScheduledEmail.Port.of({
    commitTerminalFollowUp: (email) =>
      failFollowUp
        ? Effect.fail(unavailable("follow-up"))
        : Effect.sync(() => {
            if (!followUpFacts.has(email.workflowId)) {
              followUpFacts.add(email.workflowId);
              followUps += 1;
            }
          }),
    currentAuthorization: (email, authority) =>
      Effect.succeed({
        ...currentAuthorization,
        authority:
          authority === "durableTrigger"
            ? {
                _tag: "DurableTrigger" as const,
                triggerId: email.workflowId,
                triggerType: "workflow" as const,
                userId: email.userId,
              }
            : currentAuthorization.authority,
        originatingAuthority:
          authority === "durableTrigger"
            ? {
                _tag: "DurableTrigger" as const,
                triggerId: email.workflowId,
                triggerType: "workflow" as const,
              }
            : currentAuthorization.originatingAuthority,
      }),
    persistence: {
      admit: (email) =>
        Effect.sync(() => {
          calls.push("persist.admit");
          if (stored !== null) return { _tag: "Existing" as const, email: stored };
          stored = email;
          return { _tag: "Created" as const, email };
        }),
      beginSend: (workflowId, digest, startedAt) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            if (email.state === "sending" || email.state === "send_pending_reconciliation") {
              return { _tag: "Existing" as const, email };
            }
            stored = {
              ...email,
              sendStartedAt: email.sendStartedAt ?? startedAt,
              state: "sending",
            };
            return { _tag: "Acquired" as const, email: stored };
          }),
        ),
      finishApplied: (workflowId, digest, result, outcomeAt) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            const canRefineUnaccountedAmbiguity =
              email.state === "failure" &&
              email.sendOutcome === "ambiguous" &&
              email.sendAccountingBasis === "conservative";
            if (
              email.state !== "sending" &&
              email.state !== "send_pending_reconciliation" &&
              !canRefineUnaccountedAmbiguity
            ) {
              return email;
            }
            stored = {
              ...email,
              providerLogId: result.evidence.providerLogId,
              providerResourceId: result.evidence.providerResourceId,
              sendAccountingBasis: email.sendAccountingBasis ?? "observed",
              sendOutcome: "applied",
              sendOutcomeAt: outcomeAt,
              state: "success",
              terminalAt: outcomeAt,
            };
            return stored;
          }),
        ),
      markAmbiguous: (workflowId, digest, outcomeAt) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            stored = {
              ...email,
              sendAccountingBasis: "conservative",
              sendOutcome: "ambiguous",
              sendOutcomeAt: outcomeAt,
              state: "send_pending_reconciliation",
            };
            return stored;
          }),
        ),
      finishTerminal: (
        workflowId,
        digest,
        state,
        sendOutcome,
        providerLogId,
        safeFailureCode,
        terminalAt,
      ) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            if (ScheduledEmail.terminalStates.has(email.state)) return email;
            stored = {
              ...email,
              providerLogId,
              safeFailureCode,
              sendAccountingBasis:
                email.sendAccountingBasis ?? (sendOutcome === "ambiguous" ? "conservative" : null),
              sendOutcome,
              sendOutcomeAt: sendOutcome === null ? email.sendOutcomeAt : terminalAt,
              state,
              terminalAt,
            };
            return stored;
          }),
        ),
      refineNotApplied: (workflowId, digest, providerLogId, preserveAccounting, outcomeAt) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            if (
              email.state !== "failure" ||
              email.sendOutcome !== "ambiguous" ||
              email.sendAccountingBasis !== "conservative"
            ) {
              return email;
            }
            stored = {
              ...email,
              providerLogId,
              safeFailureCode: "send-not-applied",
              sendAccountingBasis: preserveAccounting ? "conservative" : null,
              sendOutcome: "notApplied",
              sendOutcomeAt: outcomeAt,
            };
            return stored;
          }),
        ),
      inspect: () => Effect.succeed(stored),
      markAccepted: (workflowId, digest, acceptedAt) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            calls.push("persist.accept");
            stored = { ...email, acceptedAt: email.acceptedAt ?? acceptedAt, state: "accepted" };
            return stored;
          }),
        ),
      markWaiting: (workflowId, digest, waitingAt) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            stored = { ...email, state: "waiting", waitingAt: email.waitingAt ?? waitingAt };
            return stored;
          }),
        ),
      markSendAccounted: (workflowId, digest, accountedAt) =>
        failSendAccountingMarker
          ? Effect.fail(unavailable("send-accounting-marker"))
          : requireStored(workflowId, digest).pipe(
              Effect.map((email) => {
                stored = { ...email, sendAccountedAt: email.sendAccountedAt ?? accountedAt };
                return stored;
              }),
            ),
      markWorkflowStartAccounted: (workflowId, digest, accountedAt) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            stored = {
              ...email,
              workflowStartAccountedAt: email.workflowStartAccountedAt ?? accountedAt,
            };
            return stored;
          }),
        ),
      requestCancel: (workflowId, requestedUserId, requestedAt) => {
        if (stored === null || stored.userId !== requestedUserId) {
          return Effect.fail(new ScheduledEmail.NotFound({ workflowId }));
        }
        return Effect.sync(() => {
          const retained = stored;
          if (retained === null) throw new Error("Scheduled Email vanished inside fixture lock");
          stored = { ...retained, cancelRequestedAt: retained.cancelRequestedAt ?? requestedAt };
          return stored;
        });
      },
    },
    recordSendOutcome: (email) =>
      failSendAccounting
        ? Effect.fail(unavailable("send-accounting"))
        : Effect.sync(() => {
            if (
              (email.sendOutcome === "applied" || email.sendOutcome === "ambiguous") &&
              email.sendAccountingBasis !== null
            ) {
              const retainedBasis = terminalFacts.get(email.workflowId);
              if (retainedBasis !== undefined && retainedBasis !== email.sendAccountingBasis) {
                throw new Error("Scheduled Email accounting basis changed across replay");
              }
              if (retainedBasis === undefined) {
                terminalFacts.set(email.workflowId, email.sendAccountingBasis);
                gmailSendFacts += 1;
              }
            }
          }),
    sendAccountingRecorded: (email) => Effect.succeed(terminalFacts.has(email.workflowId)),
    recordWorkflowStart: (email) =>
      failWorkflowAccounting
        ? Effect.fail(unavailable("workflow-accounting"))
        : Effect.sync(() => {
            calls.push("account.workflowStart");
            if (!workflowFacts.has(email.workflowId)) {
              workflowFacts.add(email.workflowId);
              workflowStartFacts += 1;
            }
          }),
    reconcileSend: () =>
      Effect.sync(() => {
        reconciliationAttempts += 1;
        return reconciliation;
      }),
    send: (_email, authorize) => authorize.pipe(Effect.andThen(Effect.suspend(sendResult))),
    workflow: {
      create: (instanceId) =>
        failWorkflowCreate
          ? Effect.fail(unavailable("workflow.create"))
          : Effect.sync(() => {
              calls.push("workflow.create");
              if (!instances.includes(instanceId)) instances.push(instanceId);
            }),
      terminate: (instanceId) =>
        Effect.sync(() => {
          const index = instances.indexOf(instanceId);
          if (index >= 0) instances.splice(index, 1);
        }),
    },
  });

  return {
    calls,
    get currentAuthorization() {
      return currentAuthorization;
    },
    set currentAuthorization(value: AuthorizationContext) {
      currentAuthorization = value;
    },
    get followUps() {
      return followUps;
    },
    set failFollowUp(value: boolean) {
      failFollowUp = value;
    },
    set failSendAccounting(value: boolean) {
      failSendAccounting = value;
    },
    set failSendAccountingMarker(value: boolean) {
      failSendAccountingMarker = value;
    },
    set failWorkflowAccounting(value: boolean) {
      failWorkflowAccounting = value;
    },
    set failWorkflowCreate(value: boolean) {
      failWorkflowCreate = value;
    },
    get gmailSendFacts() {
      return gmailSendFacts;
    },
    get gmailSendBases() {
      return [...terminalFacts.values()];
    },
    instances,
    port,
    get reconciliation() {
      return reconciliation;
    },
    get reconciliationAttempts() {
      return reconciliationAttempts;
    },
    set reconciliation(value: ScheduledEmail.SendReconciliation) {
      reconciliation = value;
    },
    get sendAttempts() {
      return sendAttempts;
    },
    set sendOutcome(next: "ambiguous" | "applied" | "notApplied" | "unavailable" | undefined) {
      configuredSendOutcome = next;
    },
    get workflowStartFacts() {
      return workflowStartFacts;
    },
    get stored() {
      return stored;
    },
  };
};

const unavailable = (operation: string) =>
  new ScheduledEmail.Unavailable({
    cause: operation,
    message: "Injected Scheduled Email outage",
    operation,
  });

const payloadFor = (email: ScheduledEmail.Record) =>
  ScheduledEmail.WorkflowPayload.make({
    agentId: email.agentId,
    dueAt: email.dueAt,
    inputDigest: email.inputDigest,
    workflowId: email.workflowId,
  });

const layer = (port: ScheduledEmail.PortInterface) =>
  ScheduledEmail.layerWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(ScheduledEmail.Port, port)),
  );
