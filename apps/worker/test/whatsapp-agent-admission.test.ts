import type { ThinkSubmissionInspection } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Schema } from "effect";

import { ThinkSubmissionUnavailable } from "../src/services/think-submission";
import {
  AcceptanceReceiptId,
  AgentId,
  AllowancePeriodId,
  ChannelBindingId,
  ConversationRouteId,
  ProviderMessageId,
  SessionId,
  ThinkSubmissionId,
  UserMessageId,
} from "../src/domain";
import { accept, type Interface } from "../src/services/whatsapp-agent-admission";
import { type AgentAcceptanceInput, WhatsAppMessageText } from "../src/services/whatsapp-admission";
import { AuthorizationContext } from "../src/services/authorization";
import { AcceptanceReceipt } from "../src/services/whatsapp-acceptance-receipt";

/* oxlint-disable effecttsgo/schema-sync-in-effect -- Deterministic test fixtures decode controlled values inside dependency callbacks. */

describe("WhatsApp Agent admission", () => {
  it.effect("recovers accepted Think work before a later authority denial", () =>
    Effect.gen(function* () {
      let authorityCurrent = true;
      let authorityChecks = 0;
      const receiptLedger = new Map<string, AcceptanceReceipt>();
      const thinkLedger = new Map<string, ThinkSubmissionInspection>();
      const input = acceptanceInput();
      const dependencies = makeDependencies({
        inspect: (submissionId) => Effect.succeed(thinkLedger.get(submissionId) ?? null),
        inspectBinding: (userId, channelBindingId) =>
          Effect.sync(() => {
            authorityChecks += 1;
            return authorityCurrent
              ? { _tag: "ChannelBinding" as const, channelBindingId, userId }
              : { _tag: "RevokedChannelBinding" as const, channelBindingId, userId };
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
            const metadata = Schema.decodeSync(Schema.Record(Schema.String, Schema.Unknown))(
              submission.metadata,
            );
            const submissionId = Schema.decodeSync(ThinkSubmissionId)(submission.submissionId);
            const inspection = {
              createdAt: 1,
              idempotencyKey,
              metadata,
              status: "pending",
              submissionId,
            } satisfies ThinkSubmissionInspection;
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
      const thinkLedger = new Map<string, ThinkSubmissionInspection>();
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
            const inspection = {
              createdAt: 1,
              idempotencyKey: submission.idempotencyKey,
              metadata: submission.metadata,
              status: "pending" as const,
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
        inspectBinding: (userId, channelBindingId) =>
          Effect.succeed({ _tag: "RevokedChannelBinding", channelBindingId, userId }),
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
});

const makeDependencies = (
  overrides: Partial<{
    readonly inspect: Interface["think"]["inspect"];
    readonly inspectBinding: Interface["authority"]["inspect"];
    readonly readReceipt: Interface["store"]["readAcceptanceReceipt"];
    readonly recordReceipt: Interface["store"]["recordAcceptanceReceipt"];
    readonly submit: Interface["think"]["submit"];
  }>,
): Interface => ({
  authority: {
    inspect:
      overrides.inspectBinding ??
      ((userId, channelBindingId) =>
        Effect.succeed({ _tag: "ChannelBinding", channelBindingId, userId })),
  },
  store: {
    inspect: () =>
      Effect.succeed({
        _tag: "AgentFound" as const,
        agentId: AgentId.make("agent-1"),
        currentSessionId: SessionId.make("session-1"),
        routeId: ConversationRouteId.make("route-1"),
      }),
    readAcceptanceReceipt: overrides.readReceipt ?? (() => Effect.succeed(null)),
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
  authorization: authorization(),
  channelBindingId: ChannelBindingId.make("binding-1"),
  message: WhatsAppMessageText.make("Please help"),
  providerMessageId: ProviderMessageId.make("wamid.1"),
  receiptId: AcceptanceReceiptId.make("receipt-1"),
  submissionId: ThinkSubmissionId.make("submission-1"),
  userMessageId: UserMessageId.make("message-1"),
});

const authorization = () =>
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
  });

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
