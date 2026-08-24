import { expect, it } from "@effect/vitest";

import { Effect } from "effect";

import { FileAnalysisId, FileId } from "../../domain/file";
import { AnalyzeFileToolInput, makeFileTools } from "./file-tools";

/* oxlint-disable effecttsgo/async-function -- AI SDK Tool execution is a Promise boundary. */

it("keeps file work dormant and registers analysis as a resumable Action", async () => {
  const calls: Array<unknown> = [];
  const registry = makeFileTools({
    analyze: (input) =>
      Effect.sync(() => {
        calls.push({ input, operation: "analyze" });
        return { _tag: "Denied" as const, reason: "ownershipRequired" as const, resetAt: null };
      }),
    read: (input) =>
      Effect.sync(() => {
        calls.push({ input, operation: "read" });
        return { _tag: "Denied" as const, reason: "ownershipRequired" as const, resetAt: null };
      }),
  });

  expect(Object.keys(registry.actions)).toEqual(["analyzeFile"]);
  expect(Object.keys(registry.tools)).toEqual(["readFile"]);
  expect(registry.actions.analyzeFile.config.idempotencyKey).toEqual(expect.any(Function));
  expect(calls).toEqual([]);
  const readFile = registry.tools.readFile;
  if (readFile?.execute === undefined) {
    throw new Error("The file Tool registry must provide an executable read Tool");
  }

  await readFile.execute(
    { fileId: FileId.make("file-1") },
    { context: {}, messages: [], toolCallId: "read-call-1" },
  );

  expect(calls).toEqual([
    {
      input: { actionId: "read-call-1", fileId: "file-1" },
      operation: "read",
    },
  ]);
});

it("forwards a retained analysis identity to reconciliation", async () => {
  const calls: Array<unknown> = [];
  const registry = makeFileTools({
    analyze: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return { _tag: "Denied" as const, reason: "ownershipRequired" as const, resetAt: null };
      }),
    read: () => Effect.die(new Error("read is not part of this test")),
  });

  await registry.actions.analyzeFile.config.execute(
    AnalyzeFileToolInput.make({
      analysisId: FileAnalysisId.make("analysis-call-1"),
      fileId: FileId.make("file-1"),
      prompt: "Resume the analysis",
    }),
    {
      // SAFETY: This adapter test proves execute reads no Agent methods from the SDK-owned context.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      agent: undefined as never,
      attachReply: () => undefined,
      // SAFETY: This adapter test proves execute reads no environment bindings from the SDK-owned context.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      env: undefined as never,
      messages: [],
      requestId: "request-2",
      signal: new AbortController().signal,
      toolCallId: "resume-call-2",
    },
  );

  expect(calls).toEqual([
    {
      actionId: "resume-call-2",
      analysisId: "analysis-call-1",
      fileId: "file-1",
      prompt: "Resume the analysis",
    },
  ]);
});
