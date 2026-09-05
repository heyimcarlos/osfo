/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/run-effect-inside-effect, vitest/no-standalone-expect -- Fixed authority timestamps and the Promise-owned Think Action adapter exercise the production fence across separate Effect runtimes. */
import type { PendingApproval } from "@cloudflare/think";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import { UserId } from "../../domain";
import { AuthSessionId } from "../../domain/auth-session";
import { makeActionApprovals } from "../../services/action-approvals";
import { makeAccountDeletionFence } from "./account-deletion-fence";
import { presentOsfoAction, scheduledEmailStartActionName } from "./action-presentation";
import {
  ActionPresentationId,
  makeThinkActionApprovalAdapter,
  ThinkApprovalUnavailable,
} from "./think-action-approvals";

it.effect("completes nested Approval execution and serializes a replay without a timeout", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const fixture = makeApprovalFixture(() =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const first = yield* fixture.decide.pipe(Effect.forkScoped);
    yield* Deferred.await(fixture.actionRequested);
    yield* Effect.yieldNow;

    expect(yield* Deferred.isDone(started)).toBe(true);
    const replay = yield* fixture.decide.pipe(Effect.result, Effect.forkScoped);
    yield* Effect.yieldNow;
    expect(replay.pollUnsafe()).toBeUndefined();
    expect(fixture.actionClaims).toEqual([presentationId]);

    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toEqual({
      _tag: "ApprovalDecisionAccepted",
      decision: "approved",
      presentationId,
    });
    expect(yield* Fiber.join(replay)).toMatchObject({
      failure: { _tag: "ActionPresentationNotFound", presentationId },
    });
    expect(fixture.actionClaims).toEqual([presentationId]);
  }),
);

it.effect("aborts and drains admitted Approval and Action work before deletion cleanup", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const innerSignals: Array<AbortSignal> = [];
    const events: Array<string> = [];
    const fixture = makeApprovalFixture((signal) =>
      Effect.sync(() => innerSignals.push(signal)).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.sync(() => events.push("action settled"))),
      ),
    );
    const decision = yield* fixture.decide.pipe(Effect.forkScoped);
    yield* Deferred.await(fixture.actionRequested);
    yield* Effect.yieldNow;
    expect(yield* Deferred.isDone(started)).toBe(true);

    const cleanup = yield* fixture.fence.close.pipe(
      Effect.andThen(Effect.sync(() => events.push("cleanup"))),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    expect(innerSignals.map((signal) => signal.aborted)).toEqual([true]);
    expect(fixture.outerSignals.map((signal) => signal.aborted)).toEqual([true]);
    expect(cleanup.pollUnsafe()).toBeUndefined();
    expect(decision.pollUnsafe()).toBeUndefined();
    expect(events).toEqual([]);

    const late = yield* fixture.decide.pipe(Effect.result);
    expect(late).toMatchObject({ failure: { _tag: "ThinkApprovalUnavailable" } });
    expect(fixture.actionClaims).toEqual([presentationId]);
    expect(cleanup.pollUnsafe()).toBeUndefined();

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(decision);
    yield* Fiber.join(cleanup);
    expect(events).toEqual(["action settled", "cleanup"]);
  }),
);

it.effect("rejects nested Action admission when deletion closes during the Approval handoff", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const mutations: Array<string> = [];
    const fixture = makeApprovalFixture(
      () =>
        Effect.sync(() => {
          mutations.push("late action");
        }),
      Deferred.await(release),
    );
    const decision = yield* fixture.decide.pipe(Effect.result, Effect.forkScoped);
    yield* Deferred.await(fixture.actionRequested);
    const cleanup = yield* fixture.fence.close.pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    expect(fixture.outerSignals.map((signal) => signal.aborted)).toEqual([true]);
    expect(cleanup.pollUnsafe()).toBeUndefined();

    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(decision)).toMatchObject({
      failure: { _tag: "ThinkApprovalUnavailable", operation: "approveExecution" },
    });
    yield* Fiber.join(cleanup);
    expect(mutations).toEqual([]);
  }),
);

const presentationId = ActionPresentationId.make("action-pause:scheduled-email-approval");
const actor = {
  _tag: "AuthSession" as const,
  authSessionId: AuthSessionId.make("approval-session"),
  expiresAt: new Date("2026-09-06T00:00:00.000Z"),
  userId: UserId.make("approval-user"),
};

const makeApprovalFixture = (
  execute: (signal: AbortSignal) => Effect.Effect<void>,
  beforeAction = Effect.void,
) => {
  const fence = makeAccountDeletionFence();
  const actionRequested = Deferred.makeUnsafe<void>();
  const actionClaims: Array<string> = [];
  const outerSignals: Array<AbortSignal> = [];
  const pending: Array<PendingApproval> = [
    {
      descriptor: {
        action: scheduledEmailStartActionName,
        input: {
          body: "Exact scheduled message",
          gmailResource: "primary",
          recipients: ["recipient@example.test"],
          scheduledAt: "2026-09-05T17:00:00.000Z",
          subject: "Scheduled message",
        },
        kind: "durable-pause",
        permissions: ["workflows:start", "integrations:gmail:send"],
        requestId: "approval-request",
        risk: "high",
        summary: "Schedule one exact Gmail message",
        toolCallId: "scheduled-email-action",
      },
      executionId: presentationId,
      source: "action",
    },
  ];
  const approvals = makeActionApprovals({
    authorizer: { ownsAgent: (userId) => Effect.succeed(userId === actor.userId) },
    lifecycle: makeThinkActionApprovalAdapter({
      think: {
        approve: (executionId) => {
          actionClaims.push(executionId);
          pending.splice(0);
          Effect.runSync(Deferred.succeed(actionRequested, undefined));
          return Effect.runPromise(
            beforeAction.pipe(Effect.andThen(fence.runTracked(execute, closed))),
          );
        },
        pending: () => Promise.resolve(pending),
        reject: () => Promise.resolve({ status: "rejected" }),
      },
    }),
    now: Effect.succeed(new Date("2026-09-05T16:00:00.000Z")),
    present: (item, userId) => presentOsfoAction(item, undefined, userId),
    presentations: { retain: (candidate) => Effect.succeed(candidate) },
  });
  const decision = approvals.runDecision(
    approvals
      .read(actor, presentationId)
      .pipe(Effect.andThen(approvals.dispatch(actor, presentationId, "approved"))),
  );
  const decide = fence.runTracked((signal) => {
    outerSignals.push(signal);
    return decision;
  }, closed);
  return { actionClaims, actionRequested, decide, fence, outerSignals };
};

const closed = () =>
  new ThinkApprovalUnavailable({
    cause: "account deletion fence",
    message: "Action Approval is unavailable while account deletion is pending",
    operation: "decideActionApproval",
  });
