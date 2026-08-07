import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AgentRunFence } from "./index.js";

const Identity = Schema.String.check(Schema.isUUID());
const ToolCallIdentity = Schema.String.check(
  Schema.isPattern(
    /^tool_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  ),
);
const UtcTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const NonEmptyText = Schema.String.check(Schema.isNonEmpty());

export const OperationGateSchema = Schema.Literals(["deny", "requireApproval", "permit"]);
export type OperationGate = typeof OperationGateSchema.Type;

export const ActionPresentationSchema = Schema.Struct({
  version: Schema.Literal(1),
  title: NonEmptyText.check(Schema.isMaxLength(80)),
  description: NonEmptyText.check(Schema.isMaxLength(256)),
  fields: Schema.Array(
    Schema.Struct({
      label: NonEmptyText.check(Schema.isMaxLength(40)),
      value: NonEmptyText.check(Schema.isMaxLength(160)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type ActionPresentation = typeof ActionPresentationSchema.Type;

export const ActionSuccessBoundarySchema = Schema.Struct({
  ref: Schema.Literal("mailpitMessageStored.v1"),
  description: NonEmptyText.check(Schema.isMaxLength(320)),
});
export type ActionSuccessBoundary = typeof ActionSuccessBoundarySchema.Type;

export const SendDemoEmailActionSchema = Schema.Struct({
  toolCallId: ToolCallIdentity,
  agentRunId: Identity,
  actionDefinitionRef: Schema.Literal("sendDemoEmail.v1"),
  actionDigest: Sha256,
  subject: NonEmptyText.check(Schema.isMaxLength(120)),
  presentation: ActionPresentationSchema,
  successBoundary: ActionSuccessBoundarySchema,
});
export type SendDemoEmailAction = typeof SendDemoEmailActionSchema.Type;

export const ActionReceiptSchema = Schema.Struct({
  ...SendDemoEmailActionSchema.fields,
  outcome: Schema.Literals(["applied", "notApplied", "unresolved"]),
  recordedAt: UtcTimestamp,
});
export type ActionReceipt = typeof ActionReceiptSchema.Type;

export const ActionApprovalRequestSchema = Schema.Struct({
  approvalRequestId: Identity,
  action: SendDemoEmailActionSchema,
  expiresAt: UtcTimestamp,
});
export type ActionApprovalRequest = typeof ActionApprovalRequestSchema.Type;

export const SendDemoEmailActionRequestSchema = Schema.Struct({
  toolCallId: ToolCallIdentity,
  agentRunId: Identity,
  runtimeGate: OperationGateSchema,
  subject: NonEmptyText.check(Schema.isMaxLength(120)),
});
export type SendDemoEmailActionRequest = typeof SendDemoEmailActionRequestSchema.Type;

const actionSuccessBoundary = {
  description:
    "Applied means the controlled sink stored one message with this Action's stable Message-ID. It does not prove delivery to a real recipient.",
  ref: "mailpitMessageStored.v1",
} as const;

export const makeSendDemoEmailAction = (
  request: SendDemoEmailActionRequest,
): SendDemoEmailAction => {
  const presentation = {
    description: "Send one fixed-body message to the controlled development inbox.",
    fields: [
      { label: "Destination", value: "Controlled development inbox" },
      { label: "Subject", value: request.subject },
    ],
    title: "Send demo email",
    version: 1,
  } as const;
  const actionDigest = createHash("sha256")
    .update(
      JSON.stringify({
        actionDefinitionRef: "sendDemoEmail.v1",
        agentRunId: request.agentRunId,
        presentation,
        subject: request.subject,
        successBoundary: actionSuccessBoundary,
        toolCallId: request.toolCallId,
      }),
    )
    .digest("hex");
  return {
    actionDefinitionRef: "sendDemoEmail.v1",
    actionDigest,
    agentRunId: request.agentRunId,
    presentation,
    subject: request.subject,
    successBoundary: actionSuccessBoundary,
    toolCallId: request.toolCallId,
  };
};

export const ActionAttemptSchema = Schema.Struct({
  actionAttemptId: Identity,
  action: SendDemoEmailActionSchema,
  attemptNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  authorizationRevision: NonEmptyText.check(Schema.isMaxLength(128)),
  claimEpoch: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/u)),
});
export type ActionAttempt = typeof ActionAttemptSchema.Type;

export const ActionExternalResultSchema = Schema.Struct({
  type: Schema.Literals(["applied", "notApplied", "uncertain"]),
});
export type ActionExternalResult = typeof ActionExternalResultSchema.Type;

export const ActionDriveResultSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("waitingApproval"),
    approvalRequest: ActionApprovalRequestSchema,
  }),
  Schema.Struct({ type: Schema.Literal("reconcileRequired") }),
  Schema.Struct({ type: Schema.Literal("terminal"), receipt: ActionReceiptSchema }),
]);
export type ActionDriveResult = typeof ActionDriveResultSchema.Type;

export const ActionApprovalDecisionSchema = Schema.Struct({
  approvalRequestId: Identity,
  toolCallId: ToolCallIdentity,
  decisionId: Identity,
  decision: Schema.Literals(["approved", "denied"]),
});
export type ActionApprovalDecision = typeof ActionApprovalDecisionSchema.Type;

export class ActionDriverError extends Data.TaggedError("ActionDriverError")<{
  readonly cause: unknown;
}> {}

export type ActionState =
  | { readonly type: "waitingApproval"; readonly approvalRequest: ActionApprovalRequest }
  | { readonly type: "ready"; readonly action: SendDemoEmailAction }
  | { readonly type: "reconcileRequired"; readonly action: SendDemoEmailAction }
  | { readonly type: "terminal"; readonly receipt: ActionReceipt };

export type ActionAttemptClaim =
  | { readonly type: "dispatch"; readonly attempt: ActionAttempt }
  | { readonly type: "reconcile"; readonly attempt: ActionAttempt }
  | { readonly type: "terminal"; readonly receipt: ActionReceipt };

export interface ActionRepositoryService {
  readonly ensureAction: (
    fence: AgentRunFence,
    request: SendDemoEmailActionRequest,
    effectiveGate: OperationGate,
  ) => Effect.Effect<ActionState, ActionDriverError>;
  readonly decideApproval: (
    decision: ActionApprovalDecision,
  ) => Effect.Effect<void, ActionDriverError>;
  readonly beginAttempt: (
    fence: AgentRunFence,
    action: SendDemoEmailAction,
    authorizationRevision: string,
  ) => Effect.Effect<ActionAttemptClaim, ActionDriverError>;
  readonly completeWithoutDispatch: (
    fence: AgentRunFence,
    action: SendDemoEmailAction,
    cause: "applicationDenied" | "authorizationDenied",
  ) => Effect.Effect<ActionReceipt, ActionDriverError>;
  readonly recordExternalResult: (
    fence: AgentRunFence,
    attempt: ActionAttempt,
    result: ActionExternalResult,
  ) => Effect.Effect<
    | { readonly type: "reconcileRequired" }
    | { readonly type: "terminal"; readonly receipt: ActionReceipt },
    ActionDriverError
  >;
}

export class ActionRepository extends Context.Service<ActionRepository, ActionRepositoryService>()(
  "@osfo/agent-run/ActionRepository",
) {}

export class ActionApplicationPolicy extends Context.Service<
  ActionApplicationPolicy,
  { readonly gate: (request: SendDemoEmailActionRequest) => Effect.Effect<OperationGate> }
>()("@osfo/agent-run/ActionApplicationPolicy") {}

export class ActionAuthorization extends Context.Service<
  ActionAuthorization,
  {
    readonly current: (
      action: SendDemoEmailAction,
    ) => Effect.Effect<{ readonly authorized: boolean; readonly revision: string }>;
  }
>()("@osfo/agent-run/ActionAuthorization") {}

export class ActionExternalAdapter extends Context.Service<
  ActionExternalAdapter,
  {
    readonly dispatch: (attempt: ActionAttempt) => Effect.Effect<ActionExternalResult>;
    readonly reconcile: (attempt: ActionAttempt) => Effect.Effect<ActionExternalResult>;
  }
>()("@osfo/agent-run/ActionExternalAdapter") {}

export class ActionDriver extends Context.Service<
  ActionDriver,
  {
    readonly drive: (
      fence: AgentRunFence,
      request: SendDemoEmailActionRequest,
    ) => Effect.Effect<ActionDriveResult, ActionDriverError>;
    readonly decideApproval: (
      decision: ActionApprovalDecision,
    ) => Effect.Effect<void, ActionDriverError>;
  }
>()("@osfo/agent-run/ActionDriver") {}

const gateRank = { permit: 0, requireApproval: 1, deny: 2 } as const;

export const stricterOperationGate = (
  applicationGate: OperationGate,
  runtimeGate: OperationGate,
): OperationGate =>
  gateRank[applicationGate] >= gateRank[runtimeGate] ? applicationGate : runtimeGate;

export const makeActionDriverLayer = () =>
  Layer.effect(
    ActionDriver,
    Effect.gen(function* () {
      const repository = yield* ActionRepository;
      const policy = yield* ActionApplicationPolicy;
      const authorization = yield* ActionAuthorization;
      const adapter = yield* ActionExternalAdapter;

      const drive = Effect.fn("ActionDriver.drive")(function* (
        fence: AgentRunFence,
        input: SendDemoEmailActionRequest,
      ) {
        const request = yield* Schema.decodeUnknownEffect(SendDemoEmailActionRequestSchema)(
          input,
        ).pipe(Effect.mapError((cause) => new ActionDriverError({ cause })));
        if (request.agentRunId !== fence.agentRunId) {
          return yield* new ActionDriverError({ cause: "Action belongs to another AgentRun" });
        }
        const applicationGate = yield* policy.gate(request);
        const effectiveGate = stricterOperationGate(applicationGate, request.runtimeGate);
        const state = yield* repository.ensureAction(fence, request, effectiveGate);
        if (state.type === "terminal") return state;
        if (state.type === "reconcileRequired") {
          const claim = yield* repository.beginAttempt(fence, state.action, "reconciliation-only");
          if (claim.type === "terminal") return claim;
          if (claim.type !== "reconcile") {
            return yield* new ActionDriverError({
              cause: "Reconciliation state cannot create a new dispatch",
            });
          }
          const externalResult = yield* adapter.reconcile(claim.attempt);
          return yield* repository.recordExternalResult(fence, claim.attempt, externalResult);
        }
        if (effectiveGate === "deny") {
          const action = state.type === "ready" ? state.action : state.approvalRequest.action;
          const receipt = yield* repository.completeWithoutDispatch(
            fence,
            action,
            "applicationDenied",
          );
          return { type: "terminal" as const, receipt };
        }
        if (state.type === "waitingApproval") return state;

        const current = yield* authorization.current(state.action);
        if (!current.authorized) {
          const receipt = yield* repository.completeWithoutDispatch(
            fence,
            state.action,
            "authorizationDenied",
          );
          return { type: "terminal" as const, receipt };
        }
        const claim = yield* repository.beginAttempt(fence, state.action, current.revision);
        if (claim.type === "terminal") return claim;
        const externalResult =
          claim.type === "dispatch"
            ? yield* adapter.dispatch(claim.attempt)
            : yield* adapter.reconcile(claim.attempt);
        return yield* repository.recordExternalResult(fence, claim.attempt, externalResult);
      });

      return ActionDriver.of({
        drive,
        decideApproval: (decision) => repository.decideApproval(decision),
      });
    }),
  );
