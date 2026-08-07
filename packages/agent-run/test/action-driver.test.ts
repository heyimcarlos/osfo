import {
  ActionApplicationPolicy,
  ActionAuthorization,
  ActionDriver,
  ActionExternalAdapter,
  ActionRepository,
  makeActionDriverLayer,
  type ActionRepositoryService,
  type SendDemoEmailAction,
} from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

const fence = {
  agentRunId: "56c2f4aa-dac1-42ab-8252-204629a33173",
  workerId: "action-worker-a",
  claimEpoch: "1",
} as const;

const request = {
  agentRunId: fence.agentRunId,
  runtimeGate: "permit",
  subject: "Development Action proof",
  toolCallId: "tool_4ad4707e-a960-448b-ab7b-6edcc7ae213f",
} as const;

const action: SendDemoEmailAction = {
  actionDigest: "f".repeat(64),
  actionDefinitionRef: "sendDemoEmail.v1",
  agentRunId: request.agentRunId,
  presentation: {
    description: "Send one fixed-body message to the controlled development inbox.",
    fields: [
      { label: "Destination", value: "Controlled development inbox" },
      { label: "Subject", value: request.subject },
    ],
    title: "Send demo email",
    version: 1,
  },
  subject: request.subject,
  successBoundary: {
    description:
      "Applied means the controlled sink stored one message with this Action's stable Message-ID. It does not prove delivery to a real recipient.",
    ref: "mailpitMessageStored.v1",
  },
  toolCallId: request.toolCallId,
};

const makeRepository = (
  overrides: Partial<ActionRepositoryService> = {},
): ActionRepositoryService => ({
  beginAttempt: () =>
    Effect.succeed({
      type: "dispatch",
      attempt: {
        action,
        actionAttemptId: "f3466bd9-26e6-456e-904c-456198b23a57",
        attemptNumber: 1,
        authorizationRevision: "auth-revision-1",
        claimEpoch: fence.claimEpoch,
      },
    }),
  completeWithoutDispatch: () =>
    Effect.succeed({
      ...action,
      outcome: "notApplied",
      recordedAt: "2026-08-07T16:00:00.000Z",
    }),
  decideApproval: () => Effect.void,
  ensureAction: () =>
    Effect.succeed({
      type: "waitingApproval",
      approvalRequest: {
        action,
        approvalRequestId: "45c0670f-f472-487d-997a-1d2fe5baa3e8",
        expiresAt: "2026-08-07T17:00:00.000Z",
      },
    }),
  recordExternalResult: (_fence, _attempt, result) =>
    result.type === "uncertain"
      ? Effect.succeed({ type: "reconcileRequired" })
      : Effect.succeed({
          type: "terminal",
          receipt: {
            ...action,
            outcome: result.type === "applied" ? "applied" : "notApplied",
            recordedAt: "2026-08-07T16:00:00.000Z",
          },
        }),
  ...overrides,
});

const drive = (
  repository: ActionRepositoryService,
  options: {
    readonly applicationGate?: "deny" | "requireApproval" | "permit";
    readonly authorized?: boolean;
    readonly dispatchResult?: "applied" | "notApplied" | "uncertain";
    readonly reconcileResult?: "applied" | "notApplied" | "uncertain";
  } = {},
) => {
  let dispatches = 0;
  let reconciliations = 0;
  const program = Effect.gen(function* () {
    const driver = yield* ActionDriver;
    return yield* driver.drive(fence, request);
  });
  const layer = makeActionDriverLayer().pipe(
    Layer.provideMerge(Layer.succeed(ActionRepository)(repository)),
    Layer.provideMerge(
      Layer.succeed(ActionApplicationPolicy)({
        gate: () => Effect.succeed(options.applicationGate ?? "requireApproval"),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ActionAuthorization)({
        current: () =>
          Effect.succeed({
            authorized: options.authorized ?? true,
            revision: "auth-revision-1",
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ActionExternalAdapter)({
        dispatch: () => {
          dispatches += 1;
          return Effect.succeed({ type: options.dispatchResult ?? "applied" });
        },
        reconcile: () => {
          reconciliations += 1;
          return Effect.succeed({ type: options.reconcileResult ?? "uncertain" });
        },
      }),
    ),
  );
  return Effect.runPromise(program.pipe(Effect.provide(layer))).then((result) => ({
    dispatches,
    reconciliations,
    result,
  }));
};

describe("ActionDriver", () => {
  it("keeps Application policy stricter than the Runtime request", async () => {
    const denied = await drive(makeRepository(), { applicationGate: "deny" });
    const approval = await drive(makeRepository(), { applicationGate: "requireApproval" });

    expect(denied.result.type).toBe("terminal");
    expect(denied.dispatches).toBe(0);
    expect(approval.result.type).toBe("waitingApproval");
    expect(approval.dispatches).toBe(0);
  });

  it("records uncertainty and reconciles without blindly dispatching again", async () => {
    const attempt = {
      action,
      actionAttemptId: "f3466bd9-26e6-456e-904c-456198b23a57",
      attemptNumber: 1,
      authorizationRevision: "auth-revision-1",
      claimEpoch: fence.claimEpoch,
    } as const;
    const first = await drive(
      makeRepository({
        ensureAction: () => Effect.succeed({ type: "ready", action }),
      }),
      { dispatchResult: "uncertain" },
    );
    const recovered = await drive(
      makeRepository({
        ensureAction: () => Effect.succeed({ type: "ready", action }),
        beginAttempt: () => Effect.succeed({ type: "reconcile", attempt }),
      }),
      { reconcileResult: "applied" },
    );

    expect(first).toMatchObject({
      dispatches: 1,
      reconciliations: 0,
      result: { type: "reconcileRequired" },
    });
    expect(recovered).toMatchObject({
      dispatches: 0,
      reconciliations: 1,
      result: { type: "terminal", receipt: { outcome: "applied" } },
    });
  });

  it("rechecks current authorization before a new dispatch", async () => {
    let attempts = 0;
    const result = await drive(
      makeRepository({
        ensureAction: () => Effect.succeed({ type: "ready", action }),
        beginAttempt: () => {
          attempts += 1;
          return Effect.succeed({ type: "dispatch", attempt: undefined as never });
        },
      }),
      { authorized: false },
    );

    expect(result.result).toMatchObject({ type: "terminal", receipt: { outcome: "notApplied" } });
    expect(result.dispatches).toBe(0);
    expect(attempts).toBe(0);
  });
});
