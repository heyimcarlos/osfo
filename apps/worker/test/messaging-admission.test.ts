import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Layer } from "effect";

import {
  AgentId,
  AllowancePeriodId,
  ChannelBindingId,
  ChannelIdentity,
  PlanPolicyVersion,
  UserId,
} from "../src/domain";
import * as MessagingAdmission from "../src/services/messaging-admission";

describe("Messaging admission", () => {
  it.effect("returns unbound without creating a Think Submission", () => {
    const harness = makeHarness(null);
    return Effect.gen(function* () {
      const admission = yield* MessagingAdmission.Service;
      const result = yield* admission.accept(message);

      expect(result).toEqual({ _tag: "Unbound" });
      expect(harness.submissions).toEqual([]);
      expect(harness.consumptions).toEqual([]);
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Test entry point owns the Layer scope.
      Effect.provide(harness.layer),
    );
  });

  it.effect("submits a duplicate provider event to the stable Agent only once", () => {
    const harness = makeHarness(boundChannel);
    return Effect.gen(function* () {
      const admission = yield* MessagingAdmission.Service;
      const first = yield* admission.accept(message);
      const duplicate = yield* admission.accept(message);

      expect(first).toEqual({ _tag: "Accepted" });
      expect(duplicate).toEqual({ _tag: "Duplicate" });
      expect(harness.submissions).toEqual([
        {
          agentId: AgentId.make("agent-telegram"),
          idempotencyKey: "telegram-update-9001",
          message: "Plan my day",
          submissionId: "telegram-update-9001",
        },
      ]);
      expect(harness.consumptions).toEqual([
        {
          allowancePeriodId: AllowancePeriodId.make("period-telegram"),
          submissionId: "telegram-update-9001",
        },
      ]);
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Test entry point owns the Layer scope.
      Effect.provide(harness.layer),
    );
  });

  it.effect("retries an expired provider-event lease when Agent submission fails", () => {
    const harness = makeHarness(boundChannel, true);
    return Effect.gen(function* () {
      const admission = yield* MessagingAdmission.Service;
      const failed = yield* Effect.exit(admission.accept(message));
      const concurrent = yield* admission.accept(message);
      harness.expireClaims();
      const retried = yield* admission.accept(message);

      expect(Exit.isFailure(failed)).toBe(true);
      expect(concurrent).toEqual({ _tag: "InProgress" });
      expect(retried).toEqual({ _tag: "Accepted" });
      expect(harness.submissions).toHaveLength(2);
      expect(harness.consumptions).toHaveLength(1);
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Test entry point owns the Layer scope.
      Effect.provide(harness.layer),
    );
  });

  it.effect("retries an expired claim after accepted-message recording fails", () => {
    const harness = makeHarness(boundChannel, false, true);
    return Effect.gen(function* () {
      const admission = yield* MessagingAdmission.Service;
      const failed = yield* Effect.exit(admission.accept(message));
      const concurrent = yield* admission.accept(message);
      harness.expireClaims();
      const retried = yield* admission.accept(message);
      const duplicate = yield* admission.accept(message);

      expect(Exit.isFailure(failed)).toBe(true);
      expect(concurrent).toEqual({ _tag: "InProgress" });
      expect(retried).toEqual({ _tag: "Duplicate" });
      expect(duplicate).toEqual({ _tag: "Duplicate" });
      expect(harness.submissions).toHaveLength(2);
      expect(harness.consumptions).toHaveLength(1);
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Test entry point owns the Layer scope.
      Effect.provide(harness.layer),
    );
  });
});

const message: MessagingAdmission.MessageAdmissionInput = {
  channelIdentity: ChannelIdentity.make("telegram:900100200"),
  eventId: "telegram-update-9001",
  message: "Plan my day",
  provider: "telegram",
};

const boundChannel: MessagingAdmission.BoundChannel = {
  agentId: AgentId.make("agent-telegram"),
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("period-telegram"),
    endsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")),
    plan: "free",
    planPolicyVersion: PlanPolicyVersion.make("v1"),
    startsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T00:00:00.000Z")),
    usage: [],
  },
  channelBindingId: ChannelBindingId.make("binding-telegram"),
  now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T20:00:00.000Z")),
  userId: UserId.make("user-telegram"),
};

const makeHarness = (
  resolved: MessagingAdmission.BoundChannel | null,
  failFirst = false,
  failFirstRecord = false,
) => {
  const consumptions: Array<{
    readonly allowancePeriodId: AllowancePeriodId;
    readonly submissionId: string;
  }> = [];
  const submissions: Array<{
    readonly agentId: AgentId;
    readonly idempotencyKey: string;
    readonly message: string;
    readonly submissionId: string;
  }> = [];
  const submittedEventIds = new Set<string>();
  const completedEventIds = new Set<string>();
  const expiredEventIds = new Set<string>();
  const pendingEventIds = new Set<string>();
  let attempt = 0;
  let recordAttempt = 0;
  const layer = MessagingAdmission.layerWithoutDependencies.pipe(
    Layer.provideMerge(
      Layer.succeed(
        MessagingAdmission.Persistence,
        MessagingAdmission.Persistence.of({
          begin: (input) => {
            if (completedEventIds.has(input.eventId)) {
              return Effect.succeed({ _tag: "Duplicate" } as const);
            }
            if (pendingEventIds.has(input.eventId)) {
              if (expiredEventIds.delete(input.eventId) && resolved !== null) {
                return Effect.succeed(resolved);
              }
              return Effect.succeed({ _tag: "InProgress" } as const);
            }
            if (resolved === null) return Effect.succeed({ _tag: "Unbound" } as const);
            pendingEventIds.add(input.eventId);
            return Effect.succeed(resolved);
          },
          complete: (input) =>
            Effect.sync(() => {
              pendingEventIds.delete(input.eventId);
              completedEventIds.add(input.eventId);
            }),
          recordAccepted: (allowancePeriodId, submissionId) => {
            recordAttempt += 1;
            if (failFirstRecord && recordAttempt === 1) {
              return Effect.fail(
                new MessagingAdmission.MessagingAdmissionUnavailable({
                  cause: "test failure",
                  message: "Usage record unavailable",
                  operation: "recordAccepted",
                }),
              );
            }
            consumptions.push({ allowancePeriodId, submissionId });
            return Effect.void;
          },
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        MessagingAdmission.AgentSubmission,
        MessagingAdmission.AgentSubmission.of({
          submit: (agentId, input) => {
            attempt += 1;
            submissions.push({
              agentId,
              idempotencyKey: input.idempotencyKey,
              message: input.message,
              submissionId: input.submissionId,
            });
            if (failFirst && attempt === 1) {
              return Effect.fail(
                new MessagingAdmission.MessagingAdmissionUnavailable({
                  cause: "test failure",
                  message: "Agent unavailable",
                  operation: "submit",
                }),
              );
            }
            const accepted = !submittedEventIds.has(input.idempotencyKey);
            submittedEventIds.add(input.idempotencyKey);
            return Effect.succeed({ accepted });
          },
        }),
      ),
    ),
  );
  return {
    consumptions,
    expireClaims: () => pendingEventIds.forEach((eventId) => expiredEventIds.add(eventId)),
    layer,
    submissions,
  };
};
