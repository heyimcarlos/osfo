import type { ThinkSubmissionInspection } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

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
import type { AgentAcceptanceInput } from "../src/services/whatsapp-admission";
import { AuthorizationContext } from "../src/services/authorization";
import { AcceptanceReceipt } from "../src/services/whatsapp-acceptance-receipt";

/* oxlint-disable effecttsgo/schema-sync-in-effect -- Deterministic test fixtures decode controlled values inside dependency callbacks. */

describe("WhatsApp Agent admission", () => {
  it.effect("recovers accepted Think work before a later authority denial", () =>
    Effect.gen(function* () {
      let authorityCurrent = true;
      let authorityChecks = 0;
      let inspection: ThinkSubmissionInspection | null = null;
      let recorded = 0;
      let receipt: AcceptanceReceipt | null = null;
      let submissions = 0;
      const input = acceptanceInput();
      const dependencies = makeDependencies({
        inspect: () => Effect.succeed(inspection),
        isCurrent: () =>
          Effect.sync(() => {
            authorityChecks += 1;
            return authorityCurrent;
          }),
        readReceipt: () => Effect.succeed(receipt),
        recordReceipt: (candidate) =>
          Effect.sync(() => {
            recorded += 1;
            receipt = Schema.decodeSync(AcceptanceReceipt)({
              ...candidate,
              _tag: "AcceptanceReceipt",
              acceptedAt: "2026-08-16T12:00:00Z",
            });
            return receipt;
          }),
        submit: (submission) =>
          Effect.suspend(() => {
            submissions += 1;
            const idempotencyKey = Schema.decodeSync(Schema.String)(submission.idempotencyKey);
            const metadata = Schema.decodeSync(Schema.Record(Schema.String, Schema.Unknown))(
              submission.metadata,
            );
            const submissionId = Schema.decodeSync(ThinkSubmissionId)(submission.submissionId);
            inspection = {
              createdAt: 1,
              idempotencyKey,
              metadata,
              status: "pending",
              submissionId,
            };
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
      expect(submissions).toBe(1);
      expect(recorded).toBe(1);
    }),
  );

  it.effect("rechecks revocation inside the Agent before new Think work", () =>
    Effect.gen(function* () {
      let submissions = 0;
      const input = acceptanceInput();
      const dependencies = makeDependencies({
        isCurrent: () => Effect.succeed(false),
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
    readonly isCurrent: Interface["authority"]["isCurrent"];
    readonly readReceipt: Interface["store"]["readAcceptanceReceipt"];
    readonly recordReceipt: Interface["store"]["recordAcceptanceReceipt"];
    readonly submit: Interface["think"]["submit"];
  }>,
): Interface => ({
  authority: {
    isCurrent: overrides.isCurrent ?? (() => Effect.succeed(true)),
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
  message: "Please help",
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
