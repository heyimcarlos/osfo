import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { UserId } from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import {
  ActionPresentation,
  ActionPresentationId,
  type PendingThinkAction,
} from "../agents/osfo/think-action-approvals";
import { makeActionApprovals } from "./action-approvals";

/* oxlint-disable effecttsgo/global-date, vitest/no-standalone-expect -- Fixed authority time and assertions execute inside the @effect/vitest Effect callback. */

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
