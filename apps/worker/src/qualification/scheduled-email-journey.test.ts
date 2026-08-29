/* oxlint-disable effecttsgo/global-date -- Fixed due timestamps make the protected-effect fixture deterministic. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions run inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ActionId } from "../domain/action-execution";
import { AgentId, UserId } from "../domain";
import {
  ActionPresentation,
  ActionPresentationId,
  ApprovalDecisionAccepted,
} from "../agents/osfo/think-action-approvals";
import {
  approveQualificationScheduledEmail,
  hasExactRetainedQualificationScheduledEmail,
  hasConnectedQualificationGmail,
  qualificationScheduledEmailDueWithinWindow,
  qualificationScheduledEmailMessage,
  qualificationScheduledEmailRequest,
  QualificationScheduledEmailApprovalConflict,
} from "./scheduled-email-journey";

const context = {
  attemptId: "scheduled-attempt-1",
  executionId: "scheduled-execution-1",
  journey: "scheduledEmail" as const,
  offeredAtEpochMs: Date.parse("2026-08-29T16:00:00.000Z"),
  planChecksum: "scheduled-plan-1",
  region: "americas" as const,
  rootId: "scheduled-root-1",
  runId: "scheduled-run-1",
};
const fixture = {
  approval: "approveExactProtectedSend" as const,
  gmailResource: "primary" as const,
  recipient: "qualification-sink@example.test",
  version: "qualification-scheduled-email-v1" as const,
};

it.effect("approves the exact root-bound protected Scheduled Email through Think", () =>
  Effect.gen(function* () {
    const request = qualificationScheduledEmailRequest(context, fixture);
    const presentation = scheduledPresentation(request.scheduledAt);
    const decisions: Array<unknown> = [];
    const result = yield* approveQualificationScheduledEmail({
      agentId: AgentId.make("scheduled-agent-1"),
      authSessionId: "actual-better-auth-session-1",
      context,
      expiresAtUtc: "2026-08-30T16:00:00.000Z",
      fixture,
      pollAttempts: 1,
      port: {
        decideActionApproval: (_agentId, input) => {
          decisions.push(input);
          return Promise.resolve(
            ApprovalDecisionAccepted.make({
              decision: "approved",
              presentationId: presentation.presentationId,
            }),
          );
        },
        listActionPresentations: () =>
          Promise.resolve({ _tag: "ActionPresentationsFound", presentations: [presentation] }),
      },
      userId: UserId.make("scheduled-user-1"),
    });

    expect(result.request).toEqual(request);
    expect(decisions).toEqual([
      {
        actor: {
          _tag: "AuthSession",
          authSessionId: "actual-better-auth-session-1",
          expiresAt: "2026-08-30T16:00:00.000Z",
          userId: "scheduled-user-1",
        },
        decision: "approve",
        presentationId: "scheduled-presentation-1",
      },
    ]);
    expect(qualificationScheduledEmailDueWithinWindow(context, request.scheduledAt)).toBe(true);
    expect(request.scheduledAt.toISOString()).toBe("2026-08-29T16:01:30.000Z");
    expect(qualificationScheduledEmailMessage(context, fixture)).toContain(context.rootId);
  }),
);

it.effect("rejects a model-authored protected effect that differs from the frozen root", () =>
  Effect.gen(function* () {
    const result = yield* approveQualificationScheduledEmail({
      agentId: AgentId.make("scheduled-agent-1"),
      authSessionId: "actual-better-auth-session-1",
      context,
      expiresAtUtc: "2026-08-30T16:00:00.000Z",
      fixture,
      pollAttempts: 1,
      port: {
        decideActionApproval: () => Promise.reject(new Error("must not dispatch")),
        listActionPresentations: () =>
          Promise.resolve({
            _tag: "ActionPresentationsFound",
            presentations: [scheduledPresentation(new Date("2026-08-29T16:01:31.000Z"))],
          }),
      },
      userId: UserId.make("scheduled-user-1"),
    }).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure }) as const,
        onSuccess: (value) => ({ value }) as const,
      }),
    );

    expect("failure" in result && result.failure).toBeInstanceOf(
      QualificationScheduledEmailApprovalConflict,
    );
  }),
);

it("requires the actual disposable User's current Gmail connection", () => {
  expect(
    hasConnectedQualificationGmail({
      connections: [
        { status: "connected", toolkit: "gmail" },
        { status: "missing", toolkit: "googledrive" },
      ],
    }),
  ).toBe(true);
  expect(
    hasConnectedQualificationGmail({
      connections: [{ status: "missing", toolkit: "gmail" }],
    }),
  ).toBe(false);
});

it("treats only the exact already-started root as an idempotent Approval replay", () => {
  const request = qualificationScheduledEmailRequest(context, fixture);
  const retained = {
    dueAt: request.scheduledAt,
    qualificationContext: context,
    request,
  };
  expect(hasExactRetainedQualificationScheduledEmail(context, fixture, retained)).toBe(true);
  expect(
    hasExactRetainedQualificationScheduledEmail(context, fixture, {
      ...retained,
      qualificationContext: { ...context, rootId: "other-root" },
    }),
  ).toBe(false);
  expect(
    hasExactRetainedQualificationScheduledEmail(context, fixture, {
      ...retained,
      request: { ...request, body: "Changed after Approval" },
    }),
  ).toBe(false);
});

const scheduledPresentation = (scheduledAt: Date) =>
  ActionPresentation.make({
    actionDefinitionVersion: "osfo-scheduled-email-start-v1",
    actionId: ActionId.make("scheduled-action-1"),
    consequences: ["Send the exact message at the exact scheduled instant."],
    description: "Schedule the exact protected Gmail message.",
    fields: [
      { label: "Gmail mailbox", name: "gmailResource", value: "primary" },
      {
        label: "Recipients",
        name: "recipients",
        value: '["qualification-sink@example.test"]',
      },
      { label: "Subject", name: "subject", value: "Osfo qualification scheduled-root-1" },
      {
        label: "Message",
        name: "body",
        value: "Qualification delivery for scheduled-root-1.",
      },
      { label: "Send at", name: "scheduledAt", value: scheduledAt.toISOString() },
    ],
    operation: "integration.effect",
    presentationId: ActionPresentationId.make("scheduled-presentation-1"),
    title: "Schedule Gmail message",
  });
