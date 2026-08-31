import { expect, it } from "@effect/vitest";
import type { PendingApproval } from "@cloudflare/think";
import { Deferred, Effect, Fiber } from "effect";

import { UserId } from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import {
  ActionPresentation,
  ActionPresentationId,
  makeThinkActionApprovalAdapter,
  type PendingThinkAction,
} from "../agents/osfo/think-action-approvals";
import { makeActionApprovals } from "./action-approvals";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, vitest/no-standalone-expect -- Promise fakes implement the external Think port; fixed authority time and assertions execute inside the @effect/vitest Effect callback. */

it.effect("reuses the immutable Action presentation retained on its first read", () => {
  const retained = new Map<string, ActionPresentation>();
  let title = "Delete retained document";
  const pending: PendingThinkAction = {
    descriptor: {
      action: "deleteDocument",
      input: { contentId: "document-1" },
      kind: "durable-pause",
      permissions: ["files:delete"],
      requestId: "request-1",
      risk: "high",
      summary: "Delete retained document",
      toolCallId: "action-1",
    },
    executionId: ActionPresentationId.make("presentation-1"),
    source: "action",
  };
  const approvals = makeActionApprovals({
    authorizer: { ownsAgent: () => Effect.succeed(true) },
    lifecycle: {
      findPending: () => Effect.succeed(pending),
      listPending: Effect.succeed([pending]),
      resolve: () => Effect.void,
    },
    now: Effect.succeed(new Date("2026-08-24T00:00:00.000Z")),
    present: () =>
      Effect.succeed(
        ActionPresentation.make({
          actionDefinitionVersion: "delete-document-v1",
          actionId: ActionId.make("action-1"),
          consequences: ["Permanently delete the retained document."],
          description: "Delete the exact retained document shown here.",
          fields: [{ label: "Content", name: "contentId", value: "document-1" }],
          operation: "file.delete",
          presentationId: ActionPresentationId.make("presentation-1"),
          title,
        }),
      ),
    presentations: {
      retain: (candidate) => {
        const existing = retained.get(candidate.presentationId);
        if (existing !== undefined) return Effect.succeed(existing);
        retained.set(candidate.presentationId, candidate);
        return Effect.succeed(candidate);
      },
    },
  });
  const actor = {
    _tag: "AuthSession" as const,
    authSessionId: AuthSessionId.make("session-1"),
    expiresAt: new Date("2026-08-25T00:00:00.000Z"),
    userId: UserId.make("user-1"),
  };

  return Effect.gen(function* () {
    const first = yield* approvals.read(actor, pending.executionId);
    title = "Changed after deployment";
    const second = yield* approvals.read(actor, pending.executionId);
    const listed = yield* approvals.list(actor);

    expect(first.presentation.title).toBe("Delete retained document");
    expect(second.presentation).toEqual(first.presentation);
    expect(listed.presentations).toEqual([first.presentation]);
  });
});

it.effect("selects the oldest matching pending Actions before presentation work", () => {
  const pending = Array.from({ length: 62 }, (_, index): PendingThinkAction => ({
    descriptor: {
      action: index % 6 === 0 ? "scheduledEmailStart" : "gmailSendEmail",
      input: { index },
      kind: "durable-pause",
      permissions: ["gmail:send"],
      requestId: `request-${index}`,
      risk: "high",
      summary: `Action ${index}`,
      toolCallId: `action-${index}`,
    },
    executionId: ActionPresentationId.make(`presentation-${index}`),
    source: "action",
  }));
  let presentationCalls = 0;
  const approvals = makeActionApprovals({
    authorizer: { ownsAgent: () => Effect.succeed(true) },
    lifecycle: {
      findPending: () => Effect.die(new Error("not used by list")),
      listPending: Effect.succeed(pending),
      resolve: () => Effect.void,
    },
    now: Effect.succeed(new Date("2026-08-24T00:00:00.000Z")),
    present: (item) =>
      Effect.sync(() => {
        presentationCalls += 1;
        return ActionPresentation.make({
          actionDefinitionVersion: "osfo-gmail-send-v1",
          actionId: ActionId.make(item.descriptor.toolCallId),
          consequences: ["Send one message."],
          description: item.descriptor.summary,
          fields: [],
          operation: "integration.effect",
          presentationId: item.executionId,
          title: "Send Gmail message",
        });
      }),
    presentations: { retain: (candidate) => Effect.succeed(candidate) },
  });
  const actor = {
    _tag: "AuthSession" as const,
    authSessionId: AuthSessionId.make("session-1"),
    expiresAt: new Date("2026-08-25T00:00:00.000Z"),
    userId: UserId.make("user-1"),
  };

  return Effect.gen(function* () {
    const listed = yield* approvals.list(actor, {
      maximum: 50,
      select: (item) => item.descriptor.action === "gmailSendEmail",
    });
    expect(listed.presentations).toHaveLength(50);
    expect(presentationCalls).toBe(50);
    expect(listed.presentations.at(0)?.presentationId).toBe("presentation-1");
    expect(listed.presentations.at(-1)?.presentationId).toBe("presentation-59");
  });
});

it.effect(
  "serializes the complete decision handoff so a losing request cannot disturb the winner",
  () =>
    Effect.gen(function* () {
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const actor = {
        _tag: "AuthSession" as const,
        authSessionId: AuthSessionId.make("session-1"),
        // oxlint-disable-next-line effecttsgo/global-date-in-effect -- Fixed authority time keeps the concurrency test deterministic.
        expiresAt: new Date("2026-08-25T00:00:00.000Z"),
        userId: UserId.make("user-1"),
      };
      const pending: PendingThinkAction = {
        descriptor: {
          action: "gmailSendEmail",
          input: { body: "Hello", subject: "Subject", to: "person@example.com" },
          kind: "durable-pause",
          permissions: ["gmail:send"],
          requestId: "request-1",
          risk: "high",
          summary: "Send Gmail message",
          toolCallId: "action-1",
        },
        executionId: ActionPresentationId.make("presentation-1"),
        source: "action",
      };
      let pendingDecision = true;
      let winner: "approved" | "rejected" | undefined;
      const approvals = makeActionApprovals({
        authorizer: { ownsAgent: () => Effect.succeed(true) },
        lifecycle: {
          findPending: () => Effect.succeed(pending),
          listPending: Effect.succeed([pending]),
          resolve: () => Effect.void,
        },
        // oxlint-disable-next-line effecttsgo/global-date-in-effect -- Fixed authority time keeps the concurrency test deterministic.
        now: Effect.succeed(new Date("2026-08-24T00:00:00.000Z")),
        present: () =>
          Effect.succeed(
            ActionPresentation.make({
              actionDefinitionVersion: "osfo-gmail-send-v1",
              actionId: ActionId.make("action-1"),
              consequences: ["Send one message."],
              description: "Send the exact message shown here.",
              fields: [],
              operation: "integration.effect",
              presentationId: pending.executionId,
              title: "Send Gmail message",
            }),
          ),
        presentations: { retain: (candidate) => Effect.succeed(candidate) },
      });
      const decide = (decision: "approved" | "rejected", wait: boolean) =>
        approvals.runDecision(
          Effect.gen(function* () {
            yield* approvals.read(actor, pending.executionId);
            if (wait) {
              yield* Deferred.succeed(firstEntered, undefined);
              yield* Deferred.await(releaseFirst);
            }
            if (!pendingDecision) return "lost" as const;
            pendingDecision = false;
            winner = decision;
            return "won" as const;
          }),
        );

      const reject = yield* decide("rejected", true).pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);
      const approve = yield* decide("approved", false).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(approve.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseFirst, undefined);
      const rejected = yield* Fiber.join(reject);
      const approved = yield* Fiber.join(approve);
      expect(rejected).toBe("won");
      expect(approved).toBe("lost");
      expect(winner).toBe("rejected");
    }),
);

it.effect("fails the approval handoff when Think returns its nested Action error envelope", () => {
  const pending: PendingThinkAction = {
    descriptor: {
      action: "gmailSendEmail",
      input: { body: "Hello", subject: "Subject", to: "person@example.com" },
      kind: "durable-pause",
      permissions: ["gmail:send"],
      requestId: "request-1",
      risk: "high",
      summary: "Send Gmail message",
      toolCallId: "action-1",
    },
    executionId: ActionPresentationId.make("action-pause:presentation-1"),
    source: "action",
  };
  const lifecycle = makeThinkActionApprovalAdapter({
    think: {
      approve: async () => ({
        error: { message: "The retained Gmail context is unavailable", name: "Error" },
      }),
      pending: async () =>
        [
          {
            ...pending,
            descriptor: {
              ...pending.descriptor,
              permissions: [...pending.descriptor.permissions],
              risk: pending.descriptor.risk ?? "high",
            },
          },
        ] satisfies Array<PendingApproval>,
      reject: async () => ({ status: "rejected" }),
    },
  });
  const actor = {
    _tag: "AuthSession" as const,
    authSessionId: AuthSessionId.make("session-1"),
    expiresAt: new Date("2026-08-25T00:00:00.000Z"),
    userId: UserId.make("user-1"),
  };
  const approvals = makeActionApprovals({
    authorizer: { ownsAgent: () => Effect.succeed(true) },
    lifecycle,
    now: Effect.succeed(new Date("2026-08-24T00:00:00.000Z")),
    present: () => Effect.die(new Error("dispatch does not project the presentation")),
    presentations: { retain: (candidate) => Effect.succeed(candidate) },
  });

  return Effect.gen(function* () {
    const result = yield* approvals
      .dispatch(actor, pending.executionId, "approved")
      .pipe(Effect.result);

    expect(result).toMatchObject({
      failure: {
        _tag: "ThinkApprovalUnavailable",
        message: "The retained Gmail context is unavailable",
        operation: "approveExecution",
      },
    });
  });
});

it.effect("distinguishes a lost Think decision from a successful Approval dispatch", () =>
  Effect.gen(function* () {
    const presentationId = ActionPresentationId.make("action-pause:presentation-1");
    const lost = makeThinkActionApprovalAdapter({
      think: {
        approve: async () => ({ error: "already resolved", status: "error" }),
        pending: async () => [],
        reject: async () => ({ status: "rejected" }),
      },
    });
    const accepted = makeThinkActionApprovalAdapter({
      think: {
        approve: async () => ({ _tag: "IntegrationEffectCompleted" }),
        pending: async () => [],
        reject: async () => ({ status: "rejected" }),
      },
    });

    const lostResult = yield* lost.resolve(presentationId, "approved").pipe(Effect.result);
    const acceptedResult = yield* accepted.resolve(presentationId, "approved").pipe(Effect.result);

    expect(lostResult).toMatchObject({ failure: { _tag: "ApprovalAlreadyResolved" } });
    expect(acceptedResult).toMatchObject({ success: undefined });
  }),
);
