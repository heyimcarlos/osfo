import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import {
  AgentId,
  AllowancePeriodId,
  ChannelBindingId,
  ChannelIdentity,
  SessionId,
} from "../src/domain";
import type {
  AcceptanceReceiptId,
  ProviderMessageId,
  ThinkSubmissionId,
  UserMessageId,
} from "../src/domain";
import * as MessagingAdmission from "../src/services/messaging-admission";
import { AcceptanceReceipt } from "../src/services/provider-acceptance-receipt";

/* oxlint-disable effecttsgo/strict-effect-provide -- Each test is the application entry point for its isolated service Layer. */

describe("Telegram admission", () => {
  it.effect("keeps an unbound immutable provider route outside the Agent", () => {
    const harness = makeHarness({ _tag: "Unbound" });
    return Effect.gen(function* () {
      const admission = yield* MessagingAdmission.Service;
      expect(yield* admission.accept(message)).toEqual({ _tag: "Unbound" });
      expect(harness.accepted).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("recovers a duplicate provider event without a second Agent acceptance", () => {
    const harness = makeHarness(boundRoute);
    return Effect.gen(function* () {
      const admission = yield* MessagingAdmission.Service;
      expect(yield* admission.accept(message)).toEqual({ _tag: "Accepted" });
      expect(yield* admission.accept(message)).toEqual({ _tag: "Accepted" });
      expect(harness.accepted).toHaveLength(1);
      expect(harness.recoveries).toHaveLength(2);
      expect(harness.recorded).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer));
  });
});

const message: MessagingAdmission.TelegramMessageAdmissionInput = {
  channelIdentity: ChannelIdentity.make("telegram:900100200"),
  eventId: "telegram-update-9001",
  message: "Plan my day",
};

const boundRoute: MessagingAdmission.BoundChannel = {
  _tag: "Bound",
  agentId: AgentId.make("agent-telegram"),
  channelBindingId: ChannelBindingId.make("binding-telegram"),
};

const makeHarness = (route: MessagingAdmission.BoundChannel | { readonly _tag: "Unbound" }) => {
  const accepted: Array<string> = [];
  const recoveries: Array<string> = [];
  const recorded: Array<string> = [];
  let receipt: AcceptanceReceipt | null = null;
  const layer = MessagingAdmission.layerWithoutDependencies.pipe(
    Layer.provideMerge(
      Layer.succeed(
        MessagingAdmission.Persistence,
        MessagingAdmission.Persistence.of({
          admit: () => Effect.void,
          recordAccepted: (value) =>
            Effect.sync(() => {
              recorded.push(value.receiptId);
            }),
          route: () => Effect.succeed(route),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        MessagingAdmission.StableIdentity,
        MessagingAdmission.StableIdentity.of({
          deriveAdmission: () => Effect.succeed("a".repeat(40)),
          deriveContent: () => Effect.succeed("b".repeat(40)),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        MessagingAdmission.AgentSubmission,
        MessagingAdmission.AgentSubmission.of({
          accept: (_agentId, input) =>
            Effect.sync(() => {
              accepted.push(input.submissionId);
              receipt = makeReceipt(input);
              return receipt;
            }),
          recover: (_agentId, input) =>
            Effect.sync(() => {
              recoveries.push(input.submissionId);
              return receipt;
            }),
        }),
      ),
    ),
  );
  return { accepted, layer, recorded, recoveries };
};

const makeReceipt = (input: {
  readonly channelBindingId: ChannelBindingId;
  readonly providerMessageId: ProviderMessageId;
  readonly receiptId: AcceptanceReceiptId;
  readonly submissionId: ThinkSubmissionId;
  readonly userMessageId: UserMessageId;
}) =>
  Schema.decodeSync(AcceptanceReceipt)({
    _tag: "AcceptanceReceipt",
    acceptedAt: "2026-08-17T00:00:00.000Z",
    allowancePeriodId: AllowancePeriodId.make("period-telegram"),
    channelBindingId: input.channelBindingId,
    providerMessageId: input.providerMessageId,
    receiptId: input.receiptId,
    sessionId: SessionId.make("session-primary"),
    thinkSubmissionId: input.submissionId,
    userMessageId: input.userMessageId,
  });
