import { action } from "@cloudflare/think";
import { DateTime, Effect, Option, Schema } from "effect";
import { z } from "zod";

import { PlanPolicyVersion, UserId } from "../../domain";
import {
  ActionId,
  ambiguousActionResult,
  type ActionExecutionResult,
} from "../../domain/action-execution";
import { retainedCatalog } from "../../domain/plan-policy";
import { executeApprovedAction } from "../../services/action-executor";
import { AuthorizationContext, make as makeAuthorization } from "../../services/authorization";
import {
  ActionPresentation,
  ActionPresentationId,
  ActionPresentationUnavailable,
  type PendingThinkAction,
} from "./think-action-approvals";

const actionName = "osfoTestGmailSend";
const testUserId = UserId.make("test-protected-action-user");
const inputSchema = z.object({
  recipient: z.string().email().max(320),
  subject: z.string().min(1).max(200),
});
const TestActionInput = Schema.Struct({
  recipient: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
type TestActionInput = typeof TestActionInput.Type;

/** Test-only current authority and provider state used to verify the real Think Action path. */
export interface TestProtectedActionState {
  readonly authority: "active" | "revoked";
  readonly providerOutcome: "applied" | "ambiguous" | "not-applied";
}

/** Test-only dependencies for the protected Think Action vertical slice. */
export interface TestProtectedActionOptions {
  readonly readState: () => TestProtectedActionState;
}

/** Build one test-only protected Action through Think's durable Approval and action ledger. */
export const makeTestProtectedAction = (options: TestProtectedActionOptions) =>
  action({
    approval: true,
    approvalRisk: "high",
    approvalSummary: "Send the exact test email",
    description: "Send one test email after exact human Approval.",
    // oxlint-disable-next-line effecttsgo/async-function -- Think Actions require a Promise-returning execute callback.
    execute: async (input, context) =>
      Effect.runPromise(
        executeApprovedAction(
          makeAuthorization(retainedCatalog),
          currentAuthorization(options.readState()),
          { actionId: context.toolCallId, kind: "gmail.send" },
          (actionId) => contactTestProvider(options.readState(), actionId, input.recipient),
        ),
      ),
    idempotencyKey: ({ ctx }) => `test-gmail-send:${ctx.toolCallId}`,
    inputSchema,
    kind: "durable-pause",
    permissions: ["gmail:send"],
  });

/** Project the test Action's approved material without exposing raw Think input. */
export const presentTestProtectedAction = (
  pending: PendingThinkAction,
): Effect.Effect<ActionPresentation, ActionPresentationUnavailable> => {
  if (pending.descriptor.action !== actionName) {
    return Effect.fail(
      new ActionPresentationUnavailable({
        action: pending.descriptor.action,
        message: "The Action definition has no client-safe presentation",
      }),
    );
  }
  return Schema.decodeUnknownEffect(TestActionInput)(pending.descriptor.input).pipe(
    Effect.mapError(
      () =>
        new ActionPresentationUnavailable({
          action: pending.descriptor.action,
          message: "The Action input cannot be projected safely",
        }),
    ),
    Effect.map((input) =>
      ActionPresentation.make({
        actionDefinitionVersion: "osfo-test-gmail-send-v1",
        actionId: ActionId.make(pending.descriptor.toolCallId),
        consequences: ["Send one test email to the stated recipient."],
        description: "Send the exact test email shown here.",
        fields: [
          { label: "Recipient", name: "recipient", value: input.recipient },
          { label: "Subject", name: "subject", value: input.subject },
        ],
        operation: "gmail.send",
        presentationId: ActionPresentationId.make(pending.executionId),
        title: "Send test email",
      }),
    ),
  );
};

/** Remove every field not owned by the test Action's client-safe material schema. */
/* oxlint-disable osfo/no-unknown-parameters -- This is the parser at Think's untyped descriptor boundary. */
export const sanitizeTestProtectedActionInput = (
  input: unknown,
): TestActionInput | Record<string, never> =>
  Schema.decodeUnknownOption(TestActionInput)(input).pipe(
    Option.match({
      onNone: () => ({}),
      onSome: (safe) => safe,
    }),
  );
/* oxlint-enable osfo/no-unknown-parameters */

/** Name registered with Think for the test-only protected Action. */
export const testProtectedActionName = actionName;

const currentAuthorization = (state: TestProtectedActionState): AuthorizationContext =>
  AuthorizationContext.make({
    allowance: { _tag: "Unavailable" },
    approval: null,
    authority:
      state.authority === "active"
        ? {
            _tag: "ChannelBinding",
            channelBindingId: "test-protected-action-binding",
            userId: testUserId,
          }
        : {
            _tag: "RevokedChannelBinding",
            channelBindingId: "test-protected-action-binding",
            userId: testUserId,
          },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: { _tag: "Connected", userId: testUserId },
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z")),
    originatingAuthority: {
      _tag: "ChannelBinding",
      channelBindingId: "test-protected-action-binding",
    },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: testUserId,
    subscription: {
      plan: "adventurer",
      planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    },
    user: { _tag: "ActiveUser", userId: testUserId },
  });

const contactTestProvider = (
  state: TestProtectedActionState,
  actionId: ActionId,
  recipient: string,
): Effect.Effect<ActionExecutionResult> => {
  switch (state.providerOutcome) {
    case "applied":
      return Effect.succeed({
        _tag: "Applied",
        actionId,
        evidence: `The test provider accepted the message for ${recipient}`,
        providerOperationId: `test-provider:${actionId}`,
      });
    case "not-applied":
      return Effect.succeed({
        _tag: "NotApplied",
        actionId,
        evidence: "The test provider proved that it did not accept the message",
      });
    case "ambiguous":
      return Effect.succeed(
        ambiguousActionResult(actionId, "The test provider outcome could not be reconciled"),
      );
    default:
      return state.providerOutcome satisfies never;
  }
};
