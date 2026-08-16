import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Predicate, Schema } from "effect";

import { AllowancePeriodId, PlanPolicyVersion, ThinkSubmissionId } from "../src/domain";
import { Recorded, type AllowanceItem, type AllowanceSource } from "../src/domain/allowance";
import { launchModelAccessPolicy, selectManagedRoute } from "../src/domain/model-access-policy";
import { ActionId } from "../src/domain/action-approval";
import { ambiguousActionResult } from "../src/domain/action-execution";
import { boundManagedContext } from "../src/domain/managed-conversation";
import {
  ModelCallUsageDispatchUnavailable,
  ModelStepNumber,
  modelCallAttemptId,
  normalizeModelCallUsage,
  type PendingModelCallUsage,
} from "../src/domain/model-call-attempt";
import { AuthorizationContext, make as makeAuthorization } from "../src/services/authorization";
import { retainedCatalog } from "../src/domain/plan-policy";
import { executeAuthorizedAction } from "../src/services/action-executor";
import { admitManagedConversation } from "../src/services/managed-conversation";
import { makeDurableModelCallUsage, recordModelCallUsage } from "../src/services/model-call-usage";

describe("managed model access policy", () => {
  it.effect("selects bounded server-owned routes for both launch Plans", () =>
    Effect.gen(function* () {
      const free = yield* selectManagedRoute(
        launchModelAccessPolicy,
        "free",
        PlanPolicyVersion.make("launch-v1"),
      );
      const adventurer = yield* selectManagedRoute(
        launchModelAccessPolicy,
        "adventurer",
        PlanPolicyVersion.make("launch-v1"),
      );

      expect(free).toEqual({
        context: {
          maxInputTokens: 32_000,
          maxOutputTokens: 4_096,
          targetInputTokens: 18_000,
        },
        maxRetries: 0,
        maxSteps: 6,
        maxVendorUsdMicros: 30_000n,
        route: "dynamic/osfo-free-v1",
      });
      expect(adventurer).toEqual({
        context: {
          maxInputTokens: 128_000,
          maxOutputTokens: 8_192,
          targetInputTokens: 72_000,
        },
        maxRetries: 0,
        maxSteps: 12,
        maxVendorUsdMicros: 750_000n,
        route: "dynamic/osfo-adventurer-v1",
      });
    }),
  );

  it.effect("fails closed when persisted Plan policy has no managed route", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        selectManagedRoute(
          launchModelAccessPolicy,
          "free",
          PlanPolicyVersion.make("unknown-policy"),
        ),
      );

      expect(failure).toMatchObject({
        _tag: "ManagedRouteUnavailable",
        plan: "free",
        planPolicyVersion: "unknown-policy",
      });
    }),
  );

  it("requires reconciliation after an ambiguous provider outcome", () => {
    expect(ambiguousActionResult(ActionId.make("action-ambiguous"), "Provider timed out")).toEqual({
      _tag: "Ambiguous",
      actionId: "action-ambiguous",
      evidence: "Provider timed out",
      retry: "reconcile-before-retry",
    });
  });

  it.effect("pins the admitted allowance period and route to both Plan submissions", () =>
    Effect.gen(function* () {
      for (const plan of ["free", "adventurer"] as const) {
        const admitted = yield* admitManagedConversation({
          authorization: authorizationContext(plan),
          idempotencyKey: `message-${plan}`,
          message: "Help me plan the next step.",
          submissionId: ThinkSubmissionId.make(`submission-${plan}`),
        });
        expect(admitted).toMatchObject({
          _tag: "ManagedConversationAdmitted",
          metadata: {
            _tag: "OsfoManagedTurn",
            allowancePeriodId: `period-${plan}`,
            conservativeVendorUsdMicros: plan === "free" ? 30_000 : 750_000,
            maxRetries: 0,
            maxSteps: plan === "free" ? 6 : 12,
            plan,
            route: `dynamic/osfo-${plan}-v1`,
            targetInputTokens: plan === "free" ? 18_000 : 72_000,
          },
          submissionId: `submission-${plan}`,
        });
      }
    }),
  );

  it("keeps the newest messages inside each managed route input bound", () => {
    const messages = [
      { content: "a".repeat(20_000), role: "user" },
      { content: "b".repeat(20_000), role: "assistant" },
      { content: "latest", role: "user" },
    ];

    expect(boundManagedContext(messages, "Osfo instructions", 32_000)).toEqual(messages.slice(1));
    expect(boundManagedContext(messages, "Osfo instructions", 128_000)).toEqual(messages);
  });

  it.effect("checks recorded Supermemory use before managed work", () =>
    Effect.gen(function* () {
      const context = authorizationContext("free");
      expect(Predicate.isTagged(context.allowance, "Metered")).toBe(true);
      const allowance = Predicate.isTagged(context.allowance, "Metered")
        ? context.allowance
        : yield* Effect.die("The fixture must contain one metered allowance period");
      const denied = yield* admitManagedConversation({
        authorization: {
          ...context,
          allowance: {
            ...allowance,
            usage: [{ allowanceKind: "supermemoryRetrievals", quantity: 100n }],
          },
        },
        idempotencyKey: "message-exhausted",
        message: "Recall the conversation.",
        submissionId: ThinkSubmissionId.make("submission-exhausted"),
      });
      expect(denied).toMatchObject({
        _tag: "ManagedConversationDenied",
        reason: "allowanceExhausted",
      });
    }),
  );

  it("normalizes provider ambiguity as conservative cost on the existing attempt identity", () => {
    const attemptId = modelCallAttemptId(
      ThinkSubmissionId.make("submission-free"),
      ModelStepNumber.make(3),
    );
    expect(
      normalizeModelCallUsage(attemptId, {
        _tag: "Ambiguous",
        conservativeVendorUsdMicros: 30_000n,
      }),
    ).toEqual({
      items: [{ allowanceKind: "vendorUsdMicros", basis: "conservative", quantity: 30_000n }],
      source: { sourceId: "model-call-attempt:submission-free:3", sourceType: "ModelCallAttempt" },
    });
    expect(normalizeModelCallUsage(attemptId, { _tag: "NotContacted" })).toEqual({
      items: [],
      source: { sourceId: "model-call-attempt:submission-free:3", sourceType: "ModelCallAttempt" },
    });
  });

  it.effect("records available model evidence and skips proven no-use", () =>
    Effect.gen(function* () {
      const records: Array<{
        readonly items: ReadonlyArray<AllowanceItem>;
        readonly source: AllowanceSource;
      }> = [];
      const allowances = {
        inspect: () => Effect.die("Inspection is outside this recording boundary"),
        record: (
          _allowancePeriodId: AllowancePeriodId,
          source: AllowanceSource,
          items: ReadonlyArray<AllowanceItem>,
        ) => {
          records.push({ items, source });
          return Effect.succeed(Recorded.make({}));
        },
      };
      const attemptId = modelCallAttemptId(
        ThinkSubmissionId.make("submission-recording"),
        ModelStepNumber.make(2),
      );
      const periodId = AllowancePeriodId.make("period-free");

      yield* recordModelCallUsage(allowances, periodId, attemptId, {
        _tag: "Observed",
        supermemoryIngestionTokens: 120n,
        supermemoryRetrievals: 1n,
        vendorUsdMicros: 900n,
      });
      const noUse = yield* recordModelCallUsage(allowances, periodId, attemptId, {
        _tag: "NotContacted",
      });

      expect(records).toEqual([
        {
          items: [
            {
              allowanceKind: "supermemoryIngestionTokens",
              basis: "observed",
              quantity: 120n,
            },
            { allowanceKind: "supermemoryRetrievals", basis: "observed", quantity: 1n },
            { allowanceKind: "vendorUsdMicros", basis: "observed", quantity: 900n },
          ],
          source: {
            sourceId: "model-call-attempt:submission-recording:2",
            sourceType: "ModelCallAttempt",
          },
        },
      ]);
      expect(noUse).toEqual({ _tag: "NoModelCallUsage" });
    }),
  );

  it.effect("reconciles durable model evidence after a transient Allowance failure", () =>
    Effect.gen(function* () {
      const attemptId = modelCallAttemptId(
        ThinkSubmissionId.make("submission-recovery"),
        ModelStepNumber.make(1),
      );
      let dispatchAvailable = false;
      let pending: PendingModelCallUsage | null = null;
      let dispatched = false;
      const service = makeDurableModelCallUsage({
        dispatch: {
          record: (usage) =>
            dispatchAvailable
              ? Effect.void
              : Effect.fail(
                  new ModelCallUsageDispatchUnavailable({
                    attemptId: usage.attemptId,
                    message: "The test Allowance store is unavailable",
                  }),
                ),
        },
        now: Effect.succeed(date("2026-08-16T00:00:00.000Z")),
        persistence: {
          commit: (usage) =>
            Effect.sync(() => {
              pending = usage;
            }),
          markDispatched: () =>
            Effect.sync(() => {
              dispatched = true;
              pending = null;
            }),
          readPending: Effect.sync(() => {
            if (pending === null) return [];
            return [pending];
          }),
        },
      });

      const first = yield* service
        .record(AllowancePeriodId.make("period-recovery"), attemptId, {
          _tag: "Ambiguous",
          conservativeVendorUsdMicros: 30_000n,
        })
        .pipe(Effect.flip);
      expect(first).toMatchObject({ _tag: "ModelCallUsageDispatchUnavailable" });
      expect(pending).not.toBeNull();

      dispatchAvailable = true;
      yield* service.reconcile;
      expect(dispatched).toBe(true);
      expect(pending).toBeNull();
    }),
  );

  it.effect("rechecks the original acting authority immediately before provider contact", () =>
    Effect.gen(function* () {
      let contacts = 0;
      const context = authorizationContext("adventurer");
      const denied = yield* executeAuthorizedAction(
        {
          readApproved: (actionId) =>
            Effect.succeed({
              actionId,
              operation: "gmail.send",
              originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-managed" },
              userId: context.user.userId,
            }),
        },
        makeAuthorization(retainedCatalog),
        {
          ...context,
          approval: {
            actionId: "caller-supplied-approval-must-not-authorize",
            operation: "gmail.send",
            userId: context.user.userId,
          },
          authority: {
            _tag: "RevokedAuthSession",
            authSessionId: "auth-managed",
            userId: context.user.userId,
          },
          gmailConnection: { _tag: "Connected", userId: context.user.userId },
          originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-managed" },
        },
        { actionId: "send-action", kind: "gmail.send" },
        (actionId) => {
          contacts += 1;
          return Effect.succeed({
            _tag: "Applied",
            actionId,
            evidence: "Provider confirmed the send",
            providerOperationId: "provider-send-1",
          });
        },
      );

      expect(denied).toMatchObject({ _tag: "Denied", reason: "authorityRevoked" });
      expect(contacts).toBe(0);
    }),
  );
});

const authorizationContext = (plan: "free" | "adventurer") =>
  Schema.decodeSync(AuthorizationContext)({
    allowance: {
      _tag: "Metered",
      allowancePeriodId: `period-${plan}`,
      endsAt: date("2026-09-01T00:00:00.000Z"),
      plan,
      planPolicyVersion: "launch-v1",
      startsAt: date("2026-08-01T00:00:00.000Z"),
      usage: [],
    },
    approval: null,
    authority: {
      _tag: "AuthSession",
      authSessionId: "auth-managed",
      expiresAt: date("2026-08-20T00:00:00.000Z"),
      userId: "user-managed",
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: date("2026-08-16T00:00:00.000Z"),
    originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-managed" },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: null,
    subscription: { plan, planPolicyVersion: "launch-v1" },
    user: { _tag: "ActiveUser", userId: "user-managed" },
  });

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
