import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ActionPresentationId, type PendingThinkAction } from "./think-action-approvals";
import {
  hasExactActionInput,
  hasExactForgetKnowledgeInput,
  hasExactSessionDeleteInput,
  presentOsfoAction,
} from "./action-presentation";

/* oxlint-disable vitest/no-standalone-expect -- Assertion executes inside the @effect/vitest Effect callback. */

it.effect("projects the exact retained-document deletion presented for Approval", () =>
  Effect.gen(function* () {
    const pending: PendingThinkAction = {
      descriptor: {
        action: "deleteDocument",
        input: { contentId: "retained-document-1" },
        kind: "durable-pause",
        permissions: ["files:delete"],
        requestId: "request-1",
        risk: "high",
        summary: "Delete the retained generated document",
        toolCallId: "tool-call-1",
      },
      executionId: ActionPresentationId.make("execution-1"),
      source: "action",
    };

    const presentation = yield* presentOsfoAction(pending);

    expect(presentation).toEqual({
      actionDefinitionVersion: "osfo-delete-generated-document-v1",
      actionId: "tool-call-1",
      consequences: ["Permanently delete the retained generated document."],
      description: "Delete the exact retained document shown here.",
      fields: [{ label: "Content", name: "contentId", value: "retained-document-1" }],
      operation: "file.delete",
      presentationId: "execution-1",
      title: "Delete generated document",
    });
    expect(hasExactActionInput(presentation, "file.delete", "retained-document-1")).toBe(true);
    expect(hasExactActionInput(presentation, "file.delete", "retained-document-2")).toBe(false);
  }),
);

it.effect("projects the exact Knowledge deletion and Core Memory correction", () =>
  Effect.gen(function* () {
    const pending: PendingThinkAction = {
      descriptor: {
        action: "osfoForgetKnowledge",
        input: {
          coreMemory: [{ block: "userContext", content: "Prefers tea" }],
          memoryIds: ["memory-1", "memory-2"],
        },
        kind: "durable-pause",
        permissions: ["memory:delete"],
        requestId: "request-2",
        risk: "high",
        summary: "Forget selected knowledge",
        toolCallId: "tool-call-2",
      },
      executionId: ActionPresentationId.make("execution-2"),
      source: "action",
    };

    const presentation = yield* presentOsfoAction(pending);

    expect(presentation.operation).toBe("memory.forgetKnowledge");
    expect(presentation.consequences).toEqual([
      "Immediately replace the User Context Core Memory block.",
      "Permanently forget 2 selected Knowledge Base memories.",
      "Keep the original Session transcript.",
    ]);
    expect(
      hasExactForgetKnowledgeInput(presentation, {
        coreMemory: [{ block: "userContext", content: "Prefers tea" }],
        memoryIds: ["memory-1", "memory-2"],
      }),
    ).toBe(true);
    expect(
      hasExactForgetKnowledgeInput(presentation, {
        coreMemory: [{ block: "userContext", content: "Prefers coffee" }],
        memoryIds: ["memory-1", "memory-2"],
      }),
    ).toBe(false);
  }),
);

it.effect("projects the exact Session deletion", () =>
  Effect.gen(function* () {
    const pending: PendingThinkAction = {
      descriptor: {
        action: "osfoDeleteSession",
        input: { sessionId: "session-1" },
        kind: "durable-pause",
        permissions: ["sessions:delete"],
        requestId: "request-3",
        risk: "high",
        summary: "Delete one Session",
        toolCallId: "tool-call-3",
      },
      executionId: ActionPresentationId.make("execution-3"),
      source: "action",
    };

    const presentation = yield* presentOsfoAction(pending);

    expect(presentation.operation).toBe("session.delete");
    expect(presentation.consequences).toEqual([
      "Permanently delete the selected Session transcript and search history.",
      "Create a replacement first when this is the current Session.",
      "Permanently delete the matching Knowledge Base conversation.",
    ]);
    expect(hasExactSessionDeleteInput(presentation, { sessionId: "session-1" })).toBe(true);
    expect(hasExactSessionDeleteInput(presentation, { sessionId: "session-2" })).toBe(false);
  }),
);
