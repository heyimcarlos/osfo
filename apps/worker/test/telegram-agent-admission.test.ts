import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import {
  AcceptanceReceiptId,
  AllowancePeriodId,
  ChannelBindingId,
  ProviderMessageId,
  SessionId,
  ThinkSubmissionId,
  UserMessageId,
} from "../src/domain";
import { AuthorizationContext } from "../src/services/authorization";
import { AcceptanceReceipt } from "../src/services/provider-acceptance-receipt";
import type { AgentAcceptanceInput } from "../src/services/provider-message-admission";
import {
  accept,
  type Interface,
  type TelegramSubmissionInspection,
} from "../src/services/telegram-agent-admission";
import { ThinkSubmissionUnavailable } from "../src/services/think-submission";

/* oxlint-disable effecttsgo/schema-sync-in-effect -- Deterministic fixtures decode controlled receipt values inside dependency callbacks. */

describe("Telegram Agent admission", () => {
  it.effect("submits fresh work to the canonical Session and recovers a lost response", () =>
    Effect.gen(function* () {
      const input = acceptanceInput();
      const receiptLedger = new Map<string, AcceptanceReceipt>();
      const thinkLedger = new Map<ThinkSubmissionId, TelegramSubmissionInspection>();
      let authorizationChecks = 0;
      const dependencies: Interface<AcceptanceReceipt> = {
        authorization: {
          inspect: () =>
            Effect.sync(() => {
              authorizationChecks += 1;
              return authorization();
            }),
        },
        store: {
          inspect: Effect.succeed({ currentSessionId: SessionId.make("session-telegram-primary") }),
          readAcceptanceReceipt: (channelBindingId, providerMessageId) =>
            Effect.succeed(receiptLedger.get(`${channelBindingId}:${providerMessageId}`) ?? null),
          recordAcceptanceReceipt: (candidate) =>
            Effect.sync(() => {
              const receipt = Schema.decodeSync(AcceptanceReceipt)({
                ...candidate,
                _tag: "AcceptanceReceipt",
                acceptedAt: "2026-08-17T00:00:00Z",
              });
              receiptLedger.set(
                `${candidate.channelBindingId}:${candidate.providerMessageId}`,
                receipt,
              );
              return receipt;
            }),
        },
        think: {
          inspect: (submissionId) => Effect.succeed(thinkLedger.get(submissionId) ?? null),
          submit: (submission) =>
            Effect.suspend(() => {
              const inspection: TelegramSubmissionInspection = {
                idempotencyKey: submission.idempotencyKey,
                metadata: submission.metadata,
                submissionId: submission.submissionId,
              };
              thinkLedger.set(submission.submissionId, inspection);
              return Effect.fail(
                new ThinkSubmissionUnavailable({
                  cause: inspection,
                  message: "The response was lost after Think accepted",
                  operation: "runTurn",
                }),
              );
            }),
        },
      };

      yield* Effect.flip(accept({ dependencies, input }));
      const recovered = yield* accept({ dependencies, input });
      const submission = thinkLedger.get(input.submissionId);

      expect(submission).toMatchObject({
        idempotencyKey: `telegram-${input.receiptId}`,
        metadata: {
          submissionId: input.submissionId,
          telegramAcceptance: {
            channelBindingId: input.channelBindingId,
            providerMessageId: input.providerMessageId,
            sessionId: "session-telegram-primary",
            userMessageId: input.userMessageId,
          },
        },
        submissionId: input.submissionId,
      });
      expect(recovered).toMatchObject({
        _tag: "AcceptanceReceipt",
        providerMessageId: input.providerMessageId,
        sessionId: "session-telegram-primary",
        thinkSubmissionId: input.submissionId,
      });
      expect(authorizationChecks).toBe(1);
      expect(receiptLedger.size).toBe(1);
    }),
  );
});

const acceptanceInput = (): AgentAcceptanceInput => ({
  channelBindingId: ChannelBindingId.make("binding-telegram"),
  message: "Plan my day",
  providerMessageId: ProviderMessageId.make("telegram-update-9001"),
  receiptId: AcceptanceReceiptId.make("receipt-telegram"),
  submissionId: ThinkSubmissionId.make("submission-telegram"),
  userMessageId: UserMessageId.make("message-telegram"),
});

const authorization = () =>
  Schema.decodeSync(AuthorizationContext)({
    allowance: {
      _tag: "Metered" as const,
      allowancePeriodId: AllowancePeriodId.make("period-telegram"),
      endsAt: date("2026-09-01T00:00:00.000Z"),
      plan: "free" as const,
      planPolicyVersion: "launch-v1",
      startsAt: date("2026-08-01T00:00:00.000Z"),
      usage: [],
    },
    approval: null,
    authority: {
      _tag: "ChannelBinding" as const,
      channelBindingId: "binding-telegram",
      userId: "user-telegram",
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" as const },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: date("2026-08-17T00:00:00.000Z"),
    originatingAuthority: {
      _tag: "ChannelBinding" as const,
      channelBindingId: "binding-telegram",
    },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: "user-telegram",
    subscription: { plan: "free" as const, planPolicyVersion: "launch-v1" },
    user: { _tag: "ActiveUser" as const, userId: "user-telegram" },
  });

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
