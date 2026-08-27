import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import {
  ActionPresentationId,
  ActionPresentationUnavailable,
  type PendingThinkAction,
} from "./think-action-approvals";
import {
  hasExactActionInput,
  hasExactForgetKnowledgeInput,
  hasExactPersonalSkillDeleteInput,
  hasExactSessionDeleteInput,
  presentOsfoAction,
} from "./action-presentation";
import { ForgetKnowledgeInput } from "./deletion-actions";

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

    const presentation = yield* presentOsfoAction(pending, currentCoreMemory("Old preference"));

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

    const presentation = yield* presentOsfoAction(pending, currentCoreMemory("Old preference"));

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

it.effect("rejects Knowledge forgetting without an exact Core Memory correction", () =>
  Effect.gen(function* () {
    const input = {
      coreMemory: [],
      memoryIds: ["memory-1"],
    };
    const decoded = yield* Schema.decodeUnknownEffect(ForgetKnowledgeInput)(input).pipe(
      Effect.result,
    );
    const presented = yield* presentOsfoAction(
      {
        descriptor: {
          action: "osfoForgetKnowledge",
          input,
          kind: "durable-pause",
          permissions: ["memory:delete"],
          requestId: "request-empty-correction",
          risk: "high",
          summary: "Forget selected knowledge",
          toolCallId: "tool-call-empty-correction",
        },
        executionId: ActionPresentationId.make("execution-empty-correction"),
        source: "action",
      },
      currentCoreMemory("Old preference"),
    ).pipe(Effect.result);

    expect(Result.isFailure(decoded)).toBe(true);
    expect(Result.isFailure(presented)).toBe(true);
    if (Result.isFailure(presented)) {
      expect(presented.failure).toBeInstanceOf(ActionPresentationUnavailable);
    }
  }),
);

it.effect("presents and exactly verifies a near-maximum Core Memory correction", () =>
  Effect.gen(function* () {
    const input = {
      coreMemory: [{ block: "userContext" as const, content: "x".repeat(9_900) }] as const,
      memoryIds: ["memory-near-limit"] as const,
    };
    const presentation = yield* presentOsfoAction(
      {
        descriptor: {
          action: "osfoForgetKnowledge",
          input,
          kind: "durable-pause",
          permissions: ["memory:delete"],
          requestId: "request-near-limit",
          risk: "high",
          summary: "Forget selected knowledge",
          toolCallId: "tool-call-near-limit",
        },
        executionId: ActionPresentationId.make("execution-near-limit"),
        source: "action",
      },
      currentCoreMemory("prior".repeat(2_000)),
    );

    expect(presentation.fields.every(({ value }) => value.length <= 2_000)).toBe(true);
    expect(hasExactForgetKnowledgeInput(presentation, input)).toBe(true);
  }),
);

const currentCoreMemory = (userContext: string) =>
  Effect.succeed({
    _tag: "CoreMemoryInspected" as const,
    agentNotes: { content: "Current agent notes", maxTokens: 800, tokens: 3 },
    userContext: { content: userContext, maxTokens: 1_200, tokens: 3 },
  });

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

it.effect("projects and fences exact personal Skill lineage deletion", () =>
  Effect.gen(function* () {
    const pending: PendingThinkAction = {
      descriptor: {
        action: "osfoDeletePersonalSkill",
        input: { expectedSkillVersion: "weekly-status-v3", skillId: "weekly-status" },
        kind: "durable-pause",
        permissions: ["skills:delete"],
        requestId: "request-skill-delete",
        risk: "high",
        summary: "Delete one personal Skill",
        toolCallId: "tool-call-skill-delete",
      },
      executionId: ActionPresentationId.make("execution-skill-delete"),
      source: "action",
    };

    const presentation = yield* presentOsfoAction(pending);

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-personal-skill-delete-v1",
      operation: "skill.manage",
      title: "Delete personal Skill",
    });
    expect(
      hasExactPersonalSkillDeleteInput(presentation, {
        expectedSkillVersion: "weekly-status-v3",
        skillId: "weekly-status",
      }),
    ).toBe(true);
    expect(
      hasExactPersonalSkillDeleteInput(presentation, {
        expectedSkillVersion: "weekly-status-v2",
        skillId: "weekly-status",
      }),
    ).toBe(false);
  }),
);
