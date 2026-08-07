import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { normalizeOpenRouterNonActionToolCalls } from "../src/openrouter-non-action-tool-catalog.js";

const modelCallId = "0f60df64-c87c-4878-8340-001f23623491";

describe("OpenRouter non-Action ToolCall normalization", () => {
  it.effect("assembles fragmented parallel calls by index into stable bounded intent", () =>
    Effect.gen(function* () {
      const batch = yield* normalizeOpenRouterNonActionToolCalls(modelCallId, [
        {
          index: 1,
          id: "provider-call-2",
          type: "function",
          function: { name: "echo", arguments: '{"text":"sec' },
        },
        {
          index: 0,
          id: "provider-call-1",
          type: "function",
          function: { name: "echo", arguments: '{"text":"fir' },
        },
        { index: 0, function: { arguments: 'st"}' } },
        { index: 1, function: { arguments: 'ond"}' } },
      ]);

      expect(batch).toEqual({
        batchKey: `model-call:${modelCallId}`,
        attemptLimit: 2,
        requests: [
          {
            executionMode: "nonAction",
            toolName: "echo",
            input: { type: "text", text: "first" },
          },
          {
            executionMode: "nonAction",
            toolName: "echo",
            input: { type: "text", text: "second" },
          },
        ],
      });
      expect(JSON.stringify(batch)).not.toContain("provider-call");
      expect(JSON.stringify(batch)).not.toContain("arguments");
    }),
  );

  it.effect("fails closed when streamed identity or name changes", () =>
    Effect.gen(function* () {
      const changedIdentity = yield* normalizeOpenRouterNonActionToolCalls(modelCallId, [
        {
          index: 0,
          id: "provider-call-1",
          type: "function",
          function: { name: "echo", arguments: '{"text":"hello' },
        },
        {
          index: 0,
          id: "provider-call-2",
          function: { arguments: '"}' },
        },
      ]).pipe(Effect.exit);
      const changedName = yield* normalizeOpenRouterNonActionToolCalls(modelCallId, [
        {
          index: 0,
          id: "provider-call-1",
          type: "function",
          function: { name: "echo", arguments: '{"text":"hello' },
        },
        { index: 0, function: { name: "another", arguments: '"}' } },
      ]).pipe(Effect.exit);

      expect(Exit.isFailure(changedIdentity)).toBe(true);
      expect(Exit.isFailure(changedName)).toBe(true);
    }),
  );

  it.effect("rejects duplicate provider identities and non-contiguous indexes", () =>
    Effect.gen(function* () {
      const duplicateIdentity = yield* normalizeOpenRouterNonActionToolCalls(modelCallId, [
        {
          index: 0,
          id: "provider-call-1",
          type: "function",
          function: { name: "echo", arguments: '{"text":"first"}' },
        },
        {
          index: 1,
          id: "provider-call-1",
          type: "function",
          function: { name: "echo", arguments: '{"text":"second"}' },
        },
      ]).pipe(Effect.exit);
      const indexGap = yield* normalizeOpenRouterNonActionToolCalls(modelCallId, [
        {
          index: 1,
          id: "provider-call-1",
          type: "function",
          function: { name: "echo", arguments: '{"text":"second"}' },
        },
      ]).pipe(Effect.exit);

      expect(Exit.isFailure(duplicateIdentity)).toBe(true);
      expect(Exit.isFailure(indexGap)).toBe(true);
    }),
  );

  it.effect("rejects unsupported tools and non-exact JSON arguments", () =>
    Effect.gen(function* () {
      const unsupported = yield* normalizeOpenRouterNonActionToolCalls(modelCallId, [
        {
          index: 0,
          id: "provider-call-1",
          type: "function",
          function: { name: "send_email", arguments: '{"text":"secret"}' },
        },
      ]).pipe(Effect.exit);
      const excessArgument = yield* normalizeOpenRouterNonActionToolCalls(modelCallId, [
        {
          index: 0,
          id: "provider-call-1",
          type: "function",
          function: { name: "echo", arguments: '{"text":"hello","extra":true}' },
        },
      ]).pipe(Effect.exit);
      const malformedJson = yield* normalizeOpenRouterNonActionToolCalls(modelCallId, [
        {
          index: 0,
          id: "provider-call-1",
          type: "function",
          function: { name: "echo", arguments: '{"text":' },
        },
      ]).pipe(Effect.exit);

      expect(Exit.isFailure(unsupported)).toBe(true);
      expect(Exit.isFailure(excessArgument)).toBe(true);
      expect(Exit.isFailure(malformedJson)).toBe(true);
      expect(JSON.stringify(excessArgument)).not.toContain("hello");
      expect(JSON.stringify(excessArgument)).not.toContain("provider-call-1");
    }),
  );

  it.effect("rejects an unbounded fragmented completion", () =>
    Effect.gen(function* () {
      const fragments = Array.from({ length: 2_049 }, () => ({
        index: 0,
        function: { arguments: "" },
      }));
      const result = yield* normalizeOpenRouterNonActionToolCalls(modelCallId, fragments).pipe(
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});
