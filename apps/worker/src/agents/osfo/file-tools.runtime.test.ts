import { expect, it } from "@effect/vitest";
import type { ModelMessage } from "ai";

import { Effect } from "effect";

import { CapabilityCatalogVersion, UserId } from "../../domain";
import { FileAnalysisId, FileId } from "../../domain/file";
import { Capabilities } from "../../services/capabilities";
import { CapabilityContext } from "./capability-context";
import { AnalyzeFileToolInput, makeFileTools } from "./file-tools";

/* oxlint-disable effecttsgo/async-function -- AI SDK Tool execution is a Promise boundary. */

it("keeps file work dormant and registers analysis as a resumable Action", async () => {
  const calls: Array<unknown> = [];
  const registry = makeFileTools({
    reconcileAnalysis: (input) =>
      Effect.sync(() => {
        calls.push({ input, operation: "reconcileAnalysis" });
        return { _tag: "Denied" as const, reason: "ownershipRequired" as const, resetAt: null };
      }),
    read: (input) =>
      Effect.sync(() => {
        calls.push({ input, operation: "read" });
        return { _tag: "Denied" as const, reason: "ownershipRequired" as const, resetAt: null };
      }),
    startAnalysis: (input) =>
      Effect.sync(() => {
        calls.push({ input, operation: "startAnalysis" });
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
  const projection = CapabilityContext.projectTurn([
    { content: "Reconcile analysis analysis-call-1", role: "user" },
  ] satisfies Array<ModelMessage>);
  const capabilities = Capabilities.make();
  const index = await Effect.runPromise(
    capabilities.eligibleIndex({
      availableIntegrationToolkits: [],
      availableRequirements: ["file-storage", "personal-agent"],
      availableToolNames: ["analyzeFile", "loadSkill"],
      catalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
      declaredRequirements: [],
      origin: "authSession",
      personalSkills: [],
      plan: "free",
      taskDescription: projection.taskDescription,
      taskKinds: projection.taskKinds,
      userId: UserId.make("file-analysis-reconciliation-user"),
    }),
  );
  expect(
    capabilities.assembleToolBundle({
      availableToolNames: ["analyzeFile", "loadSkill"],
      index,
      loadedSkills: [],
    }).activeToolNames,
  ).toEqual(["analyzeFile"]);
  const registry = makeFileTools({
    reconcileAnalysis: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return { _tag: "Denied" as const, reason: "ownershipRequired" as const, resetAt: null };
      }),
    read: () => Effect.die(new Error("read is not part of this test")),
    startAnalysis: () => Effect.die(new Error("analysis start is not part of this test")),
  });

  await registry.actions.analyzeFile.config.execute(
    AnalyzeFileToolInput.make({
      analysisId: FileAnalysisId.make("analysis-call-1"),
      mode: "reconcile",
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
    },
  ]);
});

it("pins a new analysis identity to the Action call that starts it", async () => {
  const calls: Array<unknown> = [];
  const registry = makeFileTools({
    read: () => Effect.die(new Error("read is not part of this test")),
    reconcileAnalysis: () => Effect.die(new Error("reconciliation is not part of this test")),
    startAnalysis: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return { _tag: "Denied" as const, reason: "ownershipRequired" as const, resetAt: null };
      }),
  });

  await registry.actions.analyzeFile.config.execute(
    AnalyzeFileToolInput.make({
      fileId: FileId.make("file-1"),
      mode: "start",
      prompt: "Summarize the retained file",
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
      requestId: "request-3",
      signal: new AbortController().signal,
      toolCallId: "analysis-call-3",
    },
  );

  expect(calls).toEqual([
    {
      actionId: "analysis-call-3",
      analysisId: "analysis-call-3",
      fileId: "file-1",
      prompt: "Summarize the retained file",
    },
  ]);
});
