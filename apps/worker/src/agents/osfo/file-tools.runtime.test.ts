import { expect, it } from "@effect/vitest";
import type { ModelMessage } from "ai";

import { Effect, Schema } from "effect";

import { CapabilityCatalogVersion, UserId } from "../../domain";
import { FileAnalysisId, FileId, FileRecord } from "../../domain/file";
import { Capabilities } from "../../services/capabilities";
import { CapabilityContext } from "./capability-context";
import {
  AnalyzeFileToolInput,
  type ReadFileToolInput,
  type ValidateFileFieldsToolInput,
  type FileToolDependencies,
  makeFileTools,
} from "./file-tools";

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
  expect(Object.keys(registry.tools)).toEqual(["readFile", "validateFileFields"]);
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

const sourceSha256 = `sha256:${"a".repeat(64)}`;
const pageEvidence = [
  { page: 1, method: "native_text", text: "Fee: $200." },
  { page: 2, method: "ocr", text: "Revised fee: $250." },
];
const provenance = {
  mediaType: "application/pdf",
  parser: "bounded-pdf",
  sourceSha256,
  pages: pageEvidence,
};

const encodedProvenance = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(provenance);

const readyFile = (provenanceJson: string) =>
  Schema.decodeSync(FileRecord)({
    acceptedAt: "2026-09-05T00:00:00.000Z",
    allowancePeriodId: "period-1",
    byteLength: 100n,
    fileId: "file-1",
    fileName: "agreement.pdf",
    mediaType: "application/pdf",
    objectKey: "owned/file-1",
    sha256: sourceSha256,
    uploadId: "upload-1",
    userId: "user-1",
    deletedAt: null,
    normalizationError: null,
    normalizationClaimedAt: null,
    normalizedText: "Fee: $200. Revised fee: $250.",
    provenanceJson,
    state: "ready",
  });

const fileReadRegistry = (read: FileToolDependencies<never, never>["read"]) =>
  makeFileTools({
    read,
    reconcileAnalysis: () => Effect.die(new Error("reconciliation is not part of this test")),
    startAnalysis: () => Effect.die(new Error("analysis is not part of this test")),
  });

it("keeps source bytes used for normalization recovery out of model file content", async () => {
  const file = Schema.decodeUnknownSync(FileRecord)({
    ...readyFile(encodedProvenance),
    state: "normalizing",
    normalizationClaimedAt: "2026-09-05T00:00:00.000Z",
    normalizedText: null,
    provenanceJson: null,
  });
  const registry = fileReadRegistry(() =>
    Effect.succeed({
      _tag: "FileRead",
      bytes: new TextEncoder().encode("private source bytes"),
      file,
    }),
  );
  expect(
    await executeFileTool(registry, "readFile", { fileId: "file-1" }, "processing-read"),
  ).toEqual({
    _tag: "FileToolUnavailable",
    message: "The retained file operation is unavailable",
  });
  expect(
    await executeFileTool(
      registry,
      "validateFileFields",
      { fileId: "file-1", fields: [{ field: "reference", candidates: [] }] },
      "processing-fields",
    ),
  ).toEqual({
    _tag: "FileToolUnavailable",
    message: "The retained file operation is unavailable",
  });
});

const executeFileTool = (
  registry: ReturnType<typeof fileReadRegistry>,
  name: string,
  input: typeof ReadFileToolInput.Encoded | typeof ValidateFileFieldsToolInput.Encoded,
  toolCallId: string,
) => {
  const execute = registry.tools[name]?.execute;
  if (execute === undefined) throw new Error(`Missing executable ${name}`);
  return execute(input, { context: {}, messages: [], toolCallId });
};

it("returns native and OCR page provenance and checks known, absent, and conflicting fields", async () => {
  const calls: Array<unknown> = [];
  const registry = fileReadRegistry((input) =>
    Effect.sync(() => {
      calls.push(input);
      return {
        _tag: "FileRead",
        bytes: new Uint8Array(),
        file: readyFile(encodedProvenance),
      };
    }),
  );
  const read = await executeFileTool(registry, "readFile", { fileId: "file-1" }, "read-evidence");
  expect(read).toMatchObject({
    _tag: "FileContentRead",
    pages: pageEvidence,
    evidenceNotice: expect.stringContaining("OCR can be inaccurate"),
  });
  const checked = await executeFileTool(
    registry,
    "validateFileFields",
    {
      fileId: "file-1",
      fields: [
        {
          field: "original fee",
          candidates: [{ value: "$200", evidence: [{ page: 1, quote: "Fee: $200." }] }],
        },
        { field: "guarantor", candidates: [] },
        {
          field: "fee",
          candidates: [
            { value: "$200", evidence: [{ page: 1, quote: "Fee: $200." }] },
            { value: "$250", evidence: [{ page: 2, quote: "Revised fee: $250." }] },
          ],
        },
        {
          field: "unsupported fee",
          candidates: [{ value: "$500", evidence: [{ page: 1, quote: "Fee: $200." }] }],
        },
      ],
    },
    "check-evidence",
  );
  expect(checked).toMatchObject({
    _tag: "FileFieldsChecked",
    fileId: "file-1",
    fields: [
      { field: "original fee", status: "known", value: "$200" },
      { field: "guarantor", status: "unknown" },
      { field: "fee", status: "conflicting", values: ["$200", "$250"] },
      {
        field: "unsupported fee",
        status: "unknown",
        candidates: [{ reason: "value_not_in_quote" }],
      },
    ],
    evidenceNotice: expect.stringContaining("does not prove the field label"),
  });
  expect(calls).toEqual([
    { actionId: "read-evidence", fileId: "file-1" },
    { actionId: "check-evidence", fileId: "file-1" },
  ]);
});

it("rechecks authorization after a read and exposes no evidence after access is denied", async () => {
  const calls: Array<unknown> = [];
  const registry = fileReadRegistry((input) =>
    Effect.sync(() => {
      calls.push(input);
      if (calls.length > 1) return { _tag: "Denied", reason: "ownershipRequired", resetAt: null };
      return {
        _tag: "FileRead",
        bytes: new Uint8Array(),
        file: readyFile(encodedProvenance),
      };
    }),
  );
  await executeFileTool(registry, "readFile", { fileId: "file-1" }, "before-denial");
  expect(
    await executeFileTool(
      registry,
      "validateFileFields",
      {
        fileId: "file-1",
        fields: [
          {
            field: "fee",
            candidates: [{ value: "$200", evidence: [{ page: 1, quote: "Fee: $200." }] }],
          },
        ],
      },
      "after-denial",
    ),
  ).toEqual({
    _tag: "FileToolDenied",
    reason: "ownershipRequired",
    message: "The retained file is not available to this turn",
  });
  expect(calls).toEqual([
    { actionId: "before-denial", fileId: "file-1" },
    { actionId: "after-denial", fileId: "file-1" },
  ]);
});

it("reads legacy provenance while keeping unrecorded page evidence unknown", async () => {
  const registry = fileReadRegistry(() =>
    Effect.succeed({
      _tag: "FileRead",
      bytes: new Uint8Array(),
      file: readyFile(
        Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
          mediaType: provenance.mediaType,
          parser: provenance.parser,
          sourceSha256,
        }),
      ),
    }),
  );
  const read = await executeFileTool(registry, "readFile", { fileId: "file-1" }, "legacy-read");
  expect(read).toMatchObject({ _tag: "FileContentRead", content: "Fee: $200. Revised fee: $250." });
  expect(read).not.toHaveProperty("pages");
  expect(
    await executeFileTool(
      registry,
      "validateFileFields",
      {
        fileId: "file-1",
        fields: [
          {
            field: "fee",
            candidates: [{ value: "$200", evidence: [{ page: 1, quote: "Fee: $200." }] }],
          },
        ],
      },
      "legacy-check",
    ),
  ).toMatchObject({
    _tag: "FileFieldsChecked",
    fields: [{ status: "unknown", candidates: [{ reason: "page_unavailable" }] }],
  });
});

it.each([
  "not-json",
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
    ...provenance,
    pages: [{ page: 0, method: "ocr", text: "Fee: $200." }],
  }),
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
    ...provenance,
    sourceSha256: `sha256:${"b".repeat(64)}`,
  }),
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
    ...provenance,
    mediaType: "image/png",
  }),
])("does not expose malformed or mismatched persisted evidence %s", async (provenanceJson) => {
  const registry = fileReadRegistry(() =>
    Effect.succeed({ _tag: "FileRead", bytes: new Uint8Array(), file: readyFile(provenanceJson) }),
  );
  expect(
    await executeFileTool(
      registry,
      "validateFileFields",
      {
        fileId: "file-1",
        fields: [{ field: "fee", candidates: [] }],
      },
      "malformed-check",
    ),
  ).toEqual({ _tag: "FileToolUnavailable", message: "The retained file operation is unavailable" });
});
