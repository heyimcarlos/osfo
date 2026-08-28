/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
/* oxlint-disable effecttsgo/global-date -- Fixed authority fixtures prove exact schedule behavior. */
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

  it.effect("keeps an ambiguous provider outcome nonterminal and never resends blindly", () => {
    const fixture = makeFixture({ sendOutcome: "ambiguous" });
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
        sendOutcome: "ambiguous",
        state: "send_pending_reconciliation",
        terminalAt: null,
      });
      expect(replayed).toMatchObject({
        sendOutcome: "ambiguous",
        state: "send_pending_reconciliation",
        terminalAt: null,
      });
      expect(fixture.sendAttempts).toBe(1);
      expect(fixture.gmailSendFacts).toBe(1);
      expect(fixture.followUps).toBe(0);
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
    "resumes the same Action safely after a crash between send claim and Action retain",
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

        const recovered = yield* emails.sendDue(payload);
        expect(recovered).toMatchObject({ sendOutcome: "applied", state: "success" });
        expect(fixture.sendAttempts).toBe(1);
      }).pipe(Effect.provide(layer(fixture.port)));
    },
  );

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
      const cancellation = yield* emails.cancel(started.email.workflowId, userId);
      expect(cancellation).toMatchObject({ _tag: "ReconciliationRequired" });
      fixture.reconciliation = { _tag: "Applied", result: applied };

      const reconciled = yield* emails.sendDue(payload);
      expect(reconciled).toMatchObject({ sendOutcome: "applied", state: "success" });
      expect(fixture.sendAttempts).toBe(1);
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
  options: { readonly sendOutcome?: "ambiguous" | "applied" | "notApplied" } = {},
) => {
  let stored: ScheduledEmail.Record | null = null;
  let workflowStartFacts = 0;
  let gmailSendFacts = 0;
  let followUps = 0;
  let sendAttempts = 0;
  let currentAuthorization = authorization();
  let reconciliation: ScheduledEmail.SendReconciliation = { _tag: "Pending" };
  const calls = new Array<string>();
  const instances = new Array<ScheduledEmail.CloudflareInstanceId>();
  const terminalFacts = new Set<ScheduledEmail.WorkflowId>();
  const workflowFacts = new Set<ScheduledEmail.WorkflowId>();
  const followUpFacts = new Set<ScheduledEmail.WorkflowId>();

  const sendResult = (): Effect.Effect<
    IntegrationEffectCompleted,
    ScheduledEmail.SendAmbiguous | ScheduledEmail.SendNotApplied
  > => {
    sendAttempts += 1;
    if (options.sendOutcome === "ambiguous") {
      return Effect.fail(new ScheduledEmail.SendAmbiguous({ message: "unknown outcome" }));
    }
    if (options.sendOutcome === "notApplied") {
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
      Effect.sync(() => {
        if (!followUpFacts.has(email.workflowId)) {
          followUpFacts.add(email.workflowId);
          followUps += 1;
        }
      }),
    currentAuthorization: () => Effect.succeed(currentAuthorization),
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
            stored = {
              ...email,
              sendStartedAt: email.sendStartedAt ?? startedAt,
              state: "sending",
            };
            return stored;
          }),
        ),
      finishApplied: (workflowId, digest, result, outcomeAt) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            stored = {
              ...email,
              providerLogId: result.evidence.providerLogId,
              providerResourceId: result.evidence.providerResourceId,
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
              sendOutcome: "ambiguous",
              sendOutcomeAt: outcomeAt,
              state: "send_pending_reconciliation",
            };
            return stored;
          }),
        ),
      finishTerminal: (workflowId, digest, state, sendOutcome, safeFailureCode, terminalAt) =>
        requireStored(workflowId, digest).pipe(
          Effect.map((email) => {
            if (ScheduledEmail.terminalStates.has(email.state)) return email;
            stored = { ...email, safeFailureCode, sendOutcome, state, terminalAt };
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
      Effect.sync(() => {
        if (
          (email.sendOutcome === "applied" || email.sendOutcome === "ambiguous") &&
          !terminalFacts.has(email.workflowId)
        ) {
          terminalFacts.add(email.workflowId);
          gmailSendFacts += 1;
        }
      }),
    recordWorkflowStart: (email) =>
      Effect.sync(() => {
        calls.push("account.workflowStart");
        if (!workflowFacts.has(email.workflowId)) {
          workflowFacts.add(email.workflowId);
          workflowStartFacts += 1;
        }
      }),
    reconcileSend: () => Effect.succeed(reconciliation),
    send: (_email, authorize) => authorize.pipe(Effect.andThen(Effect.suspend(sendResult))),
    workflow: {
      create: (instanceId) =>
        Effect.sync(() => {
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
    get gmailSendFacts() {
      return gmailSendFacts;
    },
    instances,
    port,
    get reconciliation() {
      return reconciliation;
    },
    set reconciliation(value: ScheduledEmail.SendReconciliation) {
      reconciliation = value;
    },
    get sendAttempts() {
      return sendAttempts;
    },
    get workflowStartFacts() {
      return workflowStartFacts;
    },
  };
};

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
