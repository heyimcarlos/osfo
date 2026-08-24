import type { PendingApproval } from "@cloudflare/think";
import { Effect, Option, Schema } from "effect";

import { ChannelLinkId, UserId } from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { AuthSessionId } from "../../domain/auth-session";

const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

/** Opaque identity of one Think-owned pending Approval execution. */
export const ActionPresentationId = boundedText(200).pipe(Schema.brand("ActionPresentationId"));

/** Opaque identity of one Think-owned pending Approval execution. */
export type ActionPresentationId = typeof ActionPresentationId.Type;

/** One bounded client-safe field in an Action Presentation. */
export const ActionPresentationField = Schema.Struct({
  label: boundedText(80),
  name: boundedText(80),
  value: boundedText(2_000),
});

/** One immutable client-safe projection of a Think Action descriptor. */
export const ActionPresentation = Schema.Struct({
  actionDefinitionVersion: boundedText(120),
  actionId: ActionId,
  consequences: Schema.Array(boundedText(500)).check(Schema.isNonEmpty()),
  description: boundedText(1_000),
  fields: Schema.Array(ActionPresentationField),
  operation: boundedText(120),
  presentationId: ActionPresentationId,
  title: boundedText(120),
});

/** One immutable client-safe projection of a Think Action descriptor. */
export type ActionPresentation = typeof ActionPresentation.Type;

/** Worker-authenticated authority allowed to read or resolve an Approval. */
export const ApprovalActor = Schema.Union([
  Schema.TaggedStruct("AuthSession", {
    authSessionId: AuthSessionId,
    expiresAt: Schema.DateFromString,
    userId: UserId,
  }),
  Schema.TaggedStruct("ChannelLink", {
    channelLinkId: ChannelLinkId,
    userId: UserId,
  }),
]);

/** Worker-authenticated authority allowed to read or resolve an Approval. */
export type ApprovalActor = typeof ApprovalActor.Type;

/** RPC request for one pending Action Presentation. */
export const ReadActionPresentationRequest = Schema.Struct({
  actor: ApprovalActor,
  presentationId: ActionPresentationId,
});

/** RPC representation of one pending Action Presentation read. */
export type ReadActionPresentationRequest = typeof ReadActionPresentationRequest.Encoded;

/** RPC request for one exact Approval decision. */
export const DecideActionApprovalRequest = Schema.Struct({
  actor: ApprovalActor,
  decision: Schema.Literals(["approve", "reject"]),
  presentationId: ActionPresentationId,
  reason: Schema.optional(boundedText(500)),
});

/** RPC representation of one exact Approval decision. */
export type DecideActionApprovalRequest = typeof DecideActionApprovalRequest.Encoded;

/** RPC request to cancel one pending Approval. */
export const CancelActionApprovalRequest = Schema.Struct({
  actor: ApprovalActor,
  presentationId: ActionPresentationId,
  reason: boundedText(500),
});

/** RPC representation used to cancel one pending Approval. */
export type CancelActionApprovalRequest = typeof CancelActionApprovalRequest.Encoded;

/** Pending Action Presentation returned to an authenticated client. */
export const ActionPresentationFound = Schema.TaggedStruct("ActionPresentationFound", {
  presentation: ActionPresentation,
});

/** Pending Action Presentation returned to an authenticated client. */
export type ActionPresentationFound = typeof ActionPresentationFound.Type;

/** Accepted handoff of one exact decision to Think. */
export const ApprovalDecisionAccepted = Schema.TaggedStruct("ApprovalDecisionAccepted", {
  decision: Schema.Literals(["approved", "rejected", "canceled"]),
  presentationId: ActionPresentationId,
});

/** Accepted handoff of one exact decision to Think. */
export type ApprovalDecisionAccepted = typeof ApprovalDecisionAccepted.Type;

/** Expected failure when the requested Think Approval is not pending. */
export class ActionPresentationNotFound extends Schema.TaggedError<ActionPresentationNotFound>()(
  "ActionPresentationNotFound",
  { message: Schema.String, presentationId: ActionPresentationId },
) {}

/** Expected denial when an actor does not own the Agent's User. */
export class ApprovalActorUnauthorized extends Schema.TaggedError<ApprovalActorUnauthorized>()(
  "ApprovalActorUnauthorized",
  { message: Schema.String, presentationId: ActionPresentationId, userId: UserId },
) {}

/** Expected failure when current Approval authority cannot be checked. */
export class ApprovalActorAuthorizationUnavailable extends Schema.TaggedError<ApprovalActorAuthorizationUnavailable>()(
  "ApprovalActorAuthorizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String, userId: UserId },
) {}

/** Expected failure when an Action definition has no safe presentation projection. */
export class ActionPresentationUnavailable extends Schema.TaggedError<ActionPresentationUnavailable>()(
  "ActionPresentationUnavailable",
  { action: Schema.String, message: Schema.String },
) {}

/** Classified failure from a Think Approval method. */
export class ThinkApprovalUnavailable extends Schema.TaggedError<ThinkApprovalUnavailable>()(
  "ThinkApprovalUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Expected terminal answer when another Approval decision already won. */
export class ApprovalAlreadyResolved extends Schema.TaggedError<ApprovalAlreadyResolved>()(
  "ApprovalAlreadyResolved",
  { message: Schema.String, presentationId: ActionPresentationId },
) {}

/** Expected failure when an Approval RPC request is malformed. */
export class ActionApprovalRequestInvalid extends Schema.TaggedError<ActionApprovalRequestInvalid>()(
  "ActionApprovalRequestInvalid",
  { message: Schema.String, operation: Schema.String },
) {}

const ThinkActionApprovalDescriptor = Schema.Struct({
  action: Schema.String,
  input: Schema.Unknown,
  kind: Schema.Literal("durable-pause"),
  permissions: Schema.Array(Schema.String),
  requestId: Schema.String,
  risk: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  summary: Schema.String,
  toolCallId: Schema.String,
});

const ThinkPendingApproval = Schema.Struct({
  descriptor: ThinkActionApprovalDescriptor,
  executionId: ActionPresentationId,
  source: Schema.Literal("action"),
});

const ThinkDispatchError = Schema.Struct({
  error: Schema.String,
  status: Schema.Literal("error"),
});

/** Parsed pending Think Action used only inside the Approval adapter. */
export type PendingThinkAction = typeof ThinkPendingApproval.Type;

/** Think methods used by the client-safe Approval adapter. */
export interface ThinkApprovalPort {
  // oxlint-disable-next-line osfo/no-unknown-returns -- Think owns the result shape. This adapter classifies its error envelope before use.
  readonly approve: (executionId: ActionPresentationId) => Promise<unknown>;
  readonly pending: (executionId?: ActionPresentationId) => Promise<ReadonlyArray<PendingApproval>>;
  // oxlint-disable-next-line osfo/no-unknown-returns -- Think owns the result shape. This adapter classifies its error envelope before use.
  readonly reject: (executionId: ActionPresentationId, reason?: string) => Promise<unknown>;
}

/** Build the thin protocol adapter over Think's native Approval lifecycle. */
export const makeThinkActionApprovalAdapter = (options: { readonly think: ThinkApprovalPort }) => {
  const findPending = (presentationId: ActionPresentationId) =>
    callThink("pendingApprovals", () => options.think.pending(presentationId)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ThinkPendingApproval))),
      Effect.mapError((failure) =>
        Schema.is(ThinkApprovalUnavailable)(failure)
          ? failure
          : new ThinkApprovalUnavailable({
              cause: failure,
              message: "Think returned an invalid pending Approval",
              operation: "pendingApprovals",
            }),
      ),
      Effect.flatMap((pending) => {
        const first = pending[0];
        return first === undefined
          ? Effect.fail(
              new ActionPresentationNotFound({
                message: "The Action Approval is no longer pending",
                presentationId,
              }),
            )
          : Effect.succeed(first);
      }),
    );

  const resolve = (
    presentationId: ActionPresentationId,
    decision: "approved" | "rejected" | "canceled",
    reason?: string,
  ) =>
    callThink(decision === "approved" ? "approveExecution" : "rejectExecution", () =>
      decision === "approved"
        ? options.think.approve(presentationId)
        : options.think.reject(presentationId, reason),
    ).pipe(
      Effect.flatMap((result) => {
        const rejected = Schema.decodeUnknownOption(ThinkDispatchError)(result);
        return Option.isNone(rejected)
          ? Effect.void
          : Effect.fail(
              new ApprovalAlreadyResolved({
                message: rejected.value.error,
                presentationId,
              }),
            );
      }),
    );

  return { findPending, resolve };
};

const callThink = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ThinkApprovalUnavailable({
        cause,
        message: "Think Approval storage is unavailable",
        operation,
      }),
  });
