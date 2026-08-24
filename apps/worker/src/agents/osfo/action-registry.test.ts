import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ActionPresentationId, type PendingThinkAction } from "./think-action-approvals";
import { hasExactActionInput, presentOsfoAction } from "./action-presentation";

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
