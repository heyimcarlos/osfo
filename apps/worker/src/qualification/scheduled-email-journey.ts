/* oxlint-disable effecttsgo/global-date -- The frozen offered timestamp deterministically derives the protected due instant. */
import { Data, Duration, Effect, Option, Schema } from "effect";

import { hasExactScheduledEmailStartInput } from "../agents/osfo/action-presentation";
import {
  ActionPresentationsFound,
  ApprovalDecisionAccepted,
  type DecideActionApprovalRequest,
} from "../agents/osfo/think-action-approvals";
import type { AgentId, UserId } from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import type { QualificationContext } from "../domain/qualification-context";
import { ScheduledEmail } from "../services/scheduled-email";
import { qualificationChecksum } from "./qualification-checksum";

const scheduledDelayMilliseconds = 90_000;

export interface QualificationScheduledEmailFixture {
  readonly approval: "approveExactProtectedSend";
  readonly gmailResource: "primary";
  readonly recipient: string;
  readonly version: "qualification-scheduled-email-v1";
}

export interface QualificationScheduledEmailApprovalPort {
  readonly decideActionApproval: (
    agentId: string,
    input: DecideActionApprovalRequest,
  ) => Promise<object | null>;
  readonly listActionPresentations: (
    agentId: string,
    actor: QualificationAuthSessionActor,
  ) => Promise<object | null>;
}

export interface QualificationAuthSessionActor {
  readonly _tag: "AuthSession";
  readonly authSessionId: AuthSessionId;
  readonly expiresAt: string;
  readonly userId: UserId;
}

export const QualificationIntegrationConnectionSummary = Schema.Struct({
  connections: Schema.Array(Schema.Struct({ status: Schema.String, toolkit: Schema.String })),
});

export type QualificationIntegrationConnectionSummary =
  typeof QualificationIntegrationConnectionSummary.Type;

export class QualificationScheduledEmailApprovalMissing extends Data.TaggedError(
  "QualificationScheduledEmailApprovalMissing",
)<{ readonly message: string }> {}

export class QualificationScheduledEmailApprovalConflict extends Data.TaggedError(
  "QualificationScheduledEmailApprovalConflict",
)<{ readonly message: string }> {}

/** Exact protected effect frozen by the root rather than inferred from model prose. */
export const qualificationScheduledEmailRequest = (
  context: QualificationContext,
  fixture: QualificationScheduledEmailFixture,
): ScheduledEmail.Request =>
  ScheduledEmail.Request.make({
    body: `Qualification delivery for ${context.rootId}.`,
    gmailResource: fixture.gmailResource,
    recipients: [fixture.recipient],
    scheduledAt: new Date(context.offeredAtEpochMs + scheduledDelayMilliseconds),
    subject: `Osfo qualification ${context.rootId}`,
  });

/** Deterministic model instruction whose protected fields are verified again at Approval. */
export const qualificationScheduledEmailMessage = (
  context: QualificationContext,
  fixture: QualificationScheduledEmailFixture,
): string => {
  const request = qualificationScheduledEmailRequest(context, fixture);
  return [
    "Schedule this exact protected Gmail message.",
    `Mailbox: ${request.gmailResource}.`,
    `Recipient: ${request.recipients[0]}.`,
    `Subject: ${request.subject}.`,
    `Body: ${request.body}`,
    `Send at: ${request.scheduledAt.toISOString()}.`,
  ].join(" ");
};

export const hasConnectedQualificationGmail = (
  summary: QualificationIntegrationConnectionSummary,
): boolean =>
  summary.connections.some(({ status, toolkit }) => toolkit === "gmail" && status === "connected");

/** Resume Think's real durable Approval only for the exact grant-bound effect. */
export const approveQualificationScheduledEmail = Effect.fn("QualificationScheduledEmail.approve")(
  function* (input: {
    readonly agentId: AgentId;
    readonly authSessionId: string;
    readonly context: QualificationContext;
    readonly expiresAtUtc: string;
    readonly fixture: QualificationScheduledEmailFixture;
    readonly port: QualificationScheduledEmailApprovalPort;
    readonly pollAttempts?: number;
    readonly pollIntervalMilliseconds?: number;
    readonly userId: UserId;
  }) {
    const request = qualificationScheduledEmailRequest(input.context, input.fixture);
    const actor = {
      _tag: "AuthSession" as const,
      authSessionId: AuthSessionId.make(input.authSessionId),
      expiresAt: input.expiresAtUtc,
      userId: input.userId,
    };
    const attempts = input.pollAttempts ?? 30;
    const interval = input.pollIntervalMilliseconds ?? 1_000;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const listed = yield* Effect.tryPromise({
        try: () => input.port.listActionPresentations(input.agentId, actor),
        catch: () =>
          new QualificationScheduledEmailApprovalMissing({
            message: "The protected Scheduled Email Approval could not be read",
          }),
      });
      const decoded = Schema.decodeUnknownOption(ActionPresentationsFound)(listed);
      if (Option.isNone(decoded)) {
        return yield* new QualificationScheduledEmailApprovalMissing({
          message: "The Agent did not return readable Action presentations",
        });
      }
      const scheduled = decoded.value.presentations.filter(
        ({ actionDefinitionVersion }) =>
          actionDefinitionVersion === "osfo-scheduled-email-start-v1",
      );
      const exact = scheduled.filter((presentation) =>
        hasExactScheduledEmailStartInput(presentation, request),
      );
      if (exact.length > 1 || (scheduled.length > 0 && exact.length !== 1)) {
        return yield* new QualificationScheduledEmailApprovalConflict({
          message: "The pending Scheduled Email does not match the frozen protected effect",
        });
      }
      const presentation = exact[0];
      if (presentation !== undefined) {
        const decided = yield* Effect.tryPromise({
          try: () =>
            input.port.decideActionApproval(input.agentId, {
              actor,
              decision: "approve",
              presentationId: presentation.presentationId,
            }),
          catch: () =>
            new QualificationScheduledEmailApprovalMissing({
              message: "The exact Scheduled Email Approval continuation could not be dispatched",
            }),
        });
        const accepted = Schema.decodeUnknownOption(ApprovalDecisionAccepted)(decided);
        if (Option.isNone(accepted) || accepted.value.decision !== "approved") {
          return yield* new QualificationScheduledEmailApprovalConflict({
            message: "The exact Scheduled Email Approval was not accepted",
          });
        }
        return { request } as const;
      }
      if (attempt + 1 < attempts) yield* Effect.sleep(Duration.millis(interval));
    }
    return yield* new QualificationScheduledEmailApprovalMissing({
      message: "The exact Scheduled Email Approval did not become pending in time",
    });
  },
);

export const qualificationScheduledEmailDueWithinWindow = (
  context: QualificationContext,
  dueAt: Date,
): boolean => {
  const delay = dueAt.getTime() - context.offeredAtEpochMs;
  return delay > 0 && delay <= 120_000;
};

/** Replay succeeds only after the exact root-bound production row already exists. */
export const hasExactRetainedQualificationScheduledEmail = (
  context: QualificationContext,
  fixture: QualificationScheduledEmailFixture,
  email: {
    readonly dueAt: Date;
    readonly qualificationContext?: QualificationContext;
    readonly request: ScheduledEmail.Request;
  },
): boolean => {
  const expected = qualificationScheduledEmailRequest(context, fixture);
  return (
    email.qualificationContext !== undefined &&
    qualificationChecksum(email.qualificationContext) === qualificationChecksum(context) &&
    qualificationChecksum(email.request) === qualificationChecksum(expected) &&
    email.dueAt.getTime() === expected.scheduledAt.getTime() &&
    qualificationScheduledEmailDueWithinWindow(context, email.dueAt)
  );
};
