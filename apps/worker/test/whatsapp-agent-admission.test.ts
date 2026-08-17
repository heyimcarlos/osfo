import { describe, expect, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber, Schema } from "effect";

import { ThinkSubmissionUnavailable } from "../src/services/think-submission";
import {
  AcceptanceReceiptId,
  AllowancePeriodId,
  ChannelBindingId,
  ConversationRouteId,
  ProviderMessageId,
  SessionId,
  ThinkSubmissionId,
  UserId,
  UserMessageId,
} from "../src/domain";
import {
  accept,
  type Interface,
  type WhatsAppSubmissionInspection,
} from "../src/services/whatsapp-agent-admission";
import { type AgentAcceptanceInput, WhatsAppMessageText } from "../src/services/whatsapp-admission";
import { AuthorizationContext } from "../src/services/authorization";
import { AcceptanceReceipt } from "../src/services/provider-acceptance-receipt";
import { SessionCommandReceipt } from "../src/services/session-command-receipt";
import { makeSessionExecution } from "../src/agents/osfo/session-execution";

/* oxlint-disable effecttsgo/schema-sync-in-effect -- Deterministic test fixtures decode controlled values inside dependency callbacks. */

describe("WhatsApp Agent admission", () => {
  it.effect("recovers accepted Think work before a later authority denial", () =>
    Effect.gen(function* () {
      let authorityCurrent = true;
      let authorityChecks = 0;
      const receiptLedger = new Map<string, AcceptanceReceipt>();
      const thinkLedger = new Map<ThinkSubmissionId, WhatsAppSubmissionInspection>();
      const input = acceptanceInput();
      const dependencies = makeDependencies({
        inspect: (submissionId) => Effect.succeed(thinkLedger.get(submissionId) ?? null),
        inspectAuthorization: () =>
          Effect.sync(() => {
            authorityChecks += 1;
            return authorityCurrent ? authorization() : revokedAuthorization();
          }),
        readReceipt: (channelBindingId, providerMessageId) =>
          Effect.succeed(receiptLedger.get(`${channelBindingId}:${providerMessageId}`) ?? null),
        recordReceipt: (candidate) =>
          Effect.sync(() => {
            const receipt = Schema.decodeSync(AcceptanceReceipt)({
              ...candidate,
              _tag: "AcceptanceReceipt",
              acceptedAt: "2026-08-16T12:00:00Z",
            });
            receiptLedger.set(
              `${candidate.channelBindingId}:${candidate.providerMessageId}`,
              receipt,
            );
            return receipt;
          }),
        submit: (submission) =>
          Effect.suspend(() => {
            const idempotencyKey = Schema.decodeSync(Schema.String)(submission.idempotencyKey);
            const submissionId = Schema.decodeSync(ThinkSubmissionId)(submission.submissionId);
            const inspection: WhatsAppSubmissionInspection = {
              idempotencyKey,
              metadata: submission.metadata,
              submissionId,
            };
            thinkLedger.set(submissionId, inspection);
            return Effect.fail(
              new ThinkSubmissionUnavailable({
                cause: inspection,
                message: "The response was lost after Think accepted",
                operation: "runTurn",
              }),
            );
          }),
      });

      yield* Effect.flip(accept({ dependencies, input }));
      authorityCurrent = false;
      const recovered = yield* accept({ dependencies, input });

      expect(recovered).toMatchObject({
        _tag: "AcceptanceReceipt",
        allowancePeriodId: AllowancePeriodId.make("period-1"),
        channelBindingId: input.channelBindingId,
        providerMessageId: input.providerMessageId,
        receiptId: input.receiptId,
        thinkSubmissionId: input.submissionId,
        userMessageId: input.userMessageId,
      });
      expect(authorityChecks).toBe(1);
      expect(thinkLedger.size).toBe(1);
      expect(receiptLedger.size).toBe(1);
    }),
  );

  it.effect("concurrent replay creates one Think submission and one Acceptance Receipt", () =>
    Effect.gen(function* () {
      const input = acceptanceInput();
      const submitArrivals = yield* Deferred.make<void>();
      const receiptLedger = new Map<string, AcceptanceReceipt>();
      const thinkLedger = new Map<ThinkSubmissionId, WhatsAppSubmissionInspection>();
      let waiting = 0;
      const dependencies = makeDependencies({
        inspect: (submissionId) => Effect.succeed(thinkLedger.get(submissionId) ?? null),
        readReceipt: (channelBindingId, providerMessageId) =>
          Effect.succeed(receiptLedger.get(`${channelBindingId}:${providerMessageId}`) ?? null),
        recordReceipt: (candidate) =>
          Effect.sync(() => {
            const key = `${candidate.channelBindingId}:${candidate.providerMessageId}`;
            const existing = receiptLedger.get(key);
            if (existing !== undefined) return existing;
            const receipt = Schema.decodeSync(AcceptanceReceipt)({
              ...candidate,
              _tag: "AcceptanceReceipt",
              acceptedAt: "2026-08-16T12:00:00Z",
            });
            receiptLedger.set(key, receipt);
            return receipt;
          }),
        submit: (submission) =>
          Effect.gen(function* () {
            waiting += 1;
            if (waiting === 2) yield* Deferred.succeed(submitArrivals, undefined);
            yield* Deferred.await(submitArrivals);
            const existing = thinkLedger.get(submission.submissionId);
            if (existing !== undefined) return { submissionId: existing.submissionId };
            const inspection: WhatsAppSubmissionInspection = {
              idempotencyKey: submission.idempotencyKey,
              metadata: submission.metadata,
              submissionId: submission.submissionId,
            };
            thinkLedger.set(submission.submissionId, inspection);
            return { submissionId: submission.submissionId };
          }),
      });

      const accepted = yield* Effect.all(
        [accept({ dependencies, input }), accept({ dependencies, input })],
        { concurrency: "unbounded" },
      );

      expect(accepted[1]).toEqual(accepted[0]);
      expect(thinkLedger.size).toBe(1);
      expect(receiptLedger.size).toBe(1);
    }),
  );

  it.effect("rechecks revocation inside the Agent before new Think work", () =>
    Effect.gen(function* () {
      let submissions = 0;
      const input = acceptanceInput();
      const dependencies = makeDependencies({
        inspectAuthorization: () => Effect.succeed(revokedAuthorization()),
        submit: () =>
          Effect.sync(() => {
            submissions += 1;
            return {
              accepted: true,
              createdAt: 1,
              status: "pending" as const,
              submissionId: input.submissionId,
            };
          }),
      });

      const denied = yield* accept({ dependencies, input });

      expect(denied).toEqual({
        _tag: "ManagedConversationDenied",
        reason: "authorityRevoked",
        resetAt: null,
      });
      expect(submissions).toBe(0);
    }),
  );

  it.effect("uses the current inside-Agent authorization snapshot for fresh work", () =>
    Effect.gen(function* () {
      let submissions = 0;
      const input = acceptanceInput();
      const dependencies = makeDependencies({
        inspectAuthorization: () =>
          Effect.succeed(
            authorization({
              user: { _tag: "SuspendedUser", userId: UserId.make("user-1") },
            }),
          ),
        submit: (submission) =>
          Effect.sync(() => {
            submissions += 1;
            return { submissionId: submission.submissionId };
          }),
      });

      const denied = yield* accept({ dependencies, input });

      expect(denied).toEqual({
        _tag: "ManagedConversationDenied",
        reason: "userSuspended",
        resetAt: null,
      });
      expect(submissions).toBe(0);
    }),
  );

  it.effect("accepts /new through Session replacement without a Think submission", () =>
    Effect.gen(function* () {
      let replacements = 0;
      let recoveries = 0;
      let submissions = 0;
      const commandLedger = new Map<string, SessionCommandReceipt>();
      const currentRouteId = ConversationRouteId.make("route-current-at-execution");
      const input = { ...acceptanceInput(), message: WhatsAppMessageText.make("/new") };
      const replacementSessionId = SessionId.make(`session-${input.submissionId}`);
      const dependencies = makeDependencies({
        inspectAuthorization: () =>
          Effect.succeed(
            authorization({
              approval: null,
            }),
          ),
        inspectAgent: Effect.succeed({
          currentSessionId: SessionId.make("session-1"),
          routeId: currentRouteId,
        }),
        readCommandReceipt: (channelBindingId, providerMessageId) =>
          Effect.succeed(commandLedger.get(`${channelBindingId}:${providerMessageId}`) ?? null),
        recoverSession: (receipt) =>
          Effect.sync(() => {
            recoveries += 1;
            return receipt;
          }),
        replaceSession: (command, receiptInput) =>
          Effect.sync(() => {
            const key = `${receiptInput.channelBindingId}:${receiptInput.providerMessageId}`;
            const existing = commandLedger.get(key);
            if (existing !== undefined) return existing;
            replacements += 1;
            expect(command.routeId).toBe(currentRouteId);
            const receipt = Schema.decodeSync(SessionCommandReceipt)({
              ...receiptInput,
              _tag: "SessionCommandReceipt",
              acceptedAt: "2026-08-16T12:00:00Z",
              currentSessionId: replacementSessionId,
              historicalSessionId: SessionId.make("session-1"),
              routeId: command.routeId,
            });
            commandLedger.set(key, receipt);
            return receipt;
          }),
        submit: () =>
          Effect.sync(() => {
            submissions += 1;
            return { submissionId: input.submissionId };
          }),
      });

      const accepted = yield* accept({ dependencies, input });
      const replayed = yield* accept({ dependencies, input });
      const changedUser = yield* Effect.flip(
        accept({
          dependencies,
          input: { ...input, userMessageId: UserMessageId.make("message-command-changed") },
        }),
      );
      const changedReplacement = yield* Effect.flip(
        accept({
          dependencies,
          input: {
            ...input,
            submissionId: ThinkSubmissionId.make("submission-command-changed"),
          },
        }),
      );

      expect(accepted).toMatchObject({
        _tag: "SessionCommandReceipt",
        currentSessionId: replacementSessionId,
      });
      expect(replayed).toEqual(accepted);
      expect(replacements).toBe(1);
      expect(recoveries).toBe(1);
      expect(submissions).toBe(0);
      expect(commandLedger.size).toBe(1);
      expect(changedUser).toMatchObject({
        _tag: "SessionCommandReceiptConflict",
        existingUserMessageId: input.userMessageId,
        userMessageId: "message-command-changed",
      });
      expect(changedReplacement).toMatchObject({ _tag: "SessionCommandReceiptConflict" });
    }),
  );

  it.effect("keeps a normal managed turn on its Session while concurrent /new waits", () =>
    Effect.gen(function* () {
      let hasPendingOrRunning = true;
      const execution = makeSessionExecution({
        hasPendingOrRunning: Effect.sync(() => hasPendingOrRunning),
      });
      const normalEnteredThink = yield* Deferred.make<void>();
      const releaseNormal = yield* Deferred.make<void>();
      let replacementStarted = false;
      let currentSessionId = SessionId.make("session-race-old");
      const routeId = ConversationRouteId.make("route-race");
      const normalInput = acceptanceInput();
      const commandInput = {
        ...acceptanceInput(),
        message: WhatsAppMessageText.make("/new"),
        providerMessageId: ProviderMessageId.make("provider-race-command"),
        receiptId: AcceptanceReceiptId.make("receipt-race-command"),
        submissionId: ThinkSubmissionId.make("submission-race-command"),
        userMessageId: UserMessageId.make("message-race-command"),
      };
      const dependencies = makeDependencies({
        inspectAgent: Effect.sync(() => ({ currentSessionId, routeId })),
        inspectAuthorization: () =>
          Effect.succeed(
            authorization({
              approval: null,
            }),
          ),
        replaceSession: (command, receipt) =>
          Effect.sync(() => {
            replacementStarted = true;
            const historicalSessionId = currentSessionId;
            currentSessionId = SessionId.make(`session-${command.submissionId}`);
            return Schema.decodeSync(SessionCommandReceipt)({
              ...receipt,
              _tag: "SessionCommandReceipt",
              acceptedAt: "2026-08-16T12:00:00Z",
              currentSessionId,
              historicalSessionId,
              routeId: command.routeId,
            });
          }),
        submit: (submission) =>
          Deferred.succeed(normalEnteredThink, undefined).pipe(
            Effect.andThen(Deferred.await(releaseNormal)),
            Effect.tap(() =>
              Effect.sync(() => {
                hasPendingOrRunning = false;
              }).pipe(Effect.andThen(execution.submissionChanged)),
            ),
            Effect.as({ submissionId: submission.submissionId }),
          ),
      });

      const normalFiber = yield* Effect.forkChild(
        execution.run(accept({ dependencies, input: normalInput })),
      );
      yield* Deferred.await(normalEnteredThink);
      const commandFiber = yield* Effect.forkChild(
        execution.runWhenIdle(accept({ dependencies, input: commandInput })),
      );
      yield* Effect.yieldNow;
      expect(replacementStarted).toBe(false);
      yield* Deferred.succeed(releaseNormal, undefined);
      const normal = yield* Fiber.join(normalFiber);
      const command = yield* Fiber.join(commandFiber);

      expect(normal).toMatchObject({
        _tag: "AcceptanceReceipt",
        sessionId: SessionId.make("session-race-old"),
      });
      expect(command).toMatchObject({
        _tag: "SessionCommandReceipt",
        currentSessionId: SessionId.make("session-submission-race-command"),
        historicalSessionId: SessionId.make("session-race-old"),
      });
    }),
  );
});

const makeDependencies = (
  overrides: Partial<{
    readonly inspectAuthorization: Interface["authorization"]["inspect"];
    readonly inspectAgent: Interface["store"]["inspect"];
    readonly inspect: Interface["think"]["inspect"];
    readonly readReceipt: Interface["store"]["readAcceptanceReceipt"];
    readonly readCommandReceipt: Interface["store"]["readSessionCommandReceipt"];
    readonly recordReceipt: Interface["store"]["recordAcceptanceReceipt"];
    readonly replaceSession: Interface["session"]["replace"];
    readonly recoverSession: Interface["session"]["recover"];
    readonly submit: Interface["think"]["submit"];
  }>,
): Interface => ({
  authorization: {
    inspect: overrides.inspectAuthorization ?? (() => Effect.succeed(authorization())),
  },
  store: {
    inspect:
      overrides.inspectAgent ??
      Effect.succeed({
        currentSessionId: SessionId.make("session-1"),
        routeId: ConversationRouteId.make("route-1"),
      }),
    readAcceptanceReceipt: overrides.readReceipt ?? (() => Effect.succeed(null)),
    readSessionCommandReceipt: overrides.readCommandReceipt ?? (() => Effect.succeed(null)),
    recordAcceptanceReceipt:
      overrides.recordReceipt ??
      ((candidate) =>
        Effect.succeed(
          Schema.decodeSync(AcceptanceReceipt)({
            ...candidate,
            _tag: "AcceptanceReceipt",
            acceptedAt: "2026-08-16T12:00:00Z",
          }),
        )),
  },
  session: {
    recover: overrides.recoverSession ?? ((receipt) => Effect.succeed(receipt)),
    replace:
      overrides.replaceSession ??
      ((command, receipt) =>
        Effect.succeed({
          ...receipt,
          _tag: "SessionCommandReceipt" as const,
          acceptedAt: Schema.decodeSync(SessionCommandReceipt.fields.acceptedAt)(
            "2026-08-16T12:00:00Z",
          ),
          currentSessionId: SessionId.make("session-2"),
          historicalSessionId: SessionId.make("session-1"),
          routeId: command.routeId,
        })),
  },
  think: {
    inspect: overrides.inspect ?? (() => Effect.succeed(null)),
    submit:
      overrides.submit ??
      ((submission) =>
        Effect.succeed({
          accepted: true,
          createdAt: 1,
          status: "pending" as const,
          submissionId: Schema.decodeSync(ThinkSubmissionId)(submission.submissionId),
        })),
  },
});

const acceptanceInput = (): AgentAcceptanceInput => ({
  channelBindingId: ChannelBindingId.make("binding-1"),
  message: WhatsAppMessageText.make("Please help"),
  providerMessageId: ProviderMessageId.make("wamid.1"),
  receiptId: AcceptanceReceiptId.make("receipt-1"),
  submissionId: ThinkSubmissionId.make("submission-1"),
  userMessageId: UserMessageId.make("message-1"),
});

const authorization = (overrides?: Partial<AuthorizationContext>) =>
  Schema.decodeSync(AuthorizationContext)({
    allowance: {
      _tag: "Metered" as const,
      allowancePeriodId: AllowancePeriodId.make("period-1"),
      endsAt: date("2026-09-01T00:00:00.000Z"),
      plan: "free" as const,
      planPolicyVersion: "launch-v1",
      startsAt: date("2026-08-01T00:00:00.000Z"),
      usage: [],
    },
    approval: null,
    authority: {
      _tag: "ChannelBinding" as const,
      channelBindingId: "binding-1",
      userId: "user-1",
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" as const },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: date("2026-08-16T12:00:00.000Z"),
    originatingAuthority: { _tag: "ChannelBinding" as const, channelBindingId: "binding-1" },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: "user-1",
    subscription: { plan: "free" as const, planPolicyVersion: "launch-v1" },
    user: { _tag: "ActiveUser" as const, userId: "user-1" },
    ...overrides,
  });

const revokedAuthorization = () =>
  authorization({
    authority: {
      _tag: "RevokedChannelBinding",
      channelBindingId: ChannelBindingId.make("binding-1"),
      userId: UserId.make("user-1"),
    },
  });

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
