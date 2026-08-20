import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";

import { makeAgentDb } from "../src/agents/osfo/db/client";
import {
  type FileAnalysisConflict,
  type FileNotFound,
  type FileStoreRecordInvalid,
  FileStoreUnavailable,
  type FileUploadConflict,
  makeFileStore,
  type RetainedFileLimitExceeded,
} from "../src/agents/osfo/db/file-store";
import { makeR2FileObjects } from "../src/integrations/cloudflare/file-objects";
import { makeFileCompute } from "../src/integrations/cloudflare/file-compute";
import type { OsfoAgent } from "../src/agents/osfo/agent";
import { AgentId, AllowancePeriodId, PlanPolicyVersion, UserId } from "../src/domain";
import { AuthSessionId } from "../src/domain/auth-session";
import { DbTimestamp } from "../src/db";
import { FileAnalysisId, FileId, FileUploadId } from "../src/domain/file";
import { FileDigest, inspectFileContent } from "../src/domain/file-content";
import { retainedCatalog, type PlanPolicyCatalog } from "../src/domain/plan-policy";
import { Authorization, type AuthorizationContext } from "../src/services/authorization";
import {
  FileComputeFailed,
  fileAnalysisExecutionPending,
  type FileCompute,
  type FileStateTransitionConflict,
  type FileAnalysisComputeResult,
  makeFiles,
} from "../src/services/files";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, eslint/no-underscore-dangle -- Cloudflare test helpers cross Promise boundaries, fixtures use fixed Date values, and Effect outcomes use `_tag`. */

describe("Agent-owned file ingestion", () => {
  it.effect("runs only the fixed bounded Python file task and destroys normalization compute", () =>
    Effect.gen(function* () {
      const sandbox = new TestFileSandbox({
        normalizedText: "bounded text",
        ok: true,
        parser: "python-test-v1",
      });
      const compute = makeFileCompute(() => sandbox);
      const sourceSha256 = digest("a");
      const normalized = yield* compute.normalize({
        bytes: new TextEncoder().encode("source"),
        conservativeVendorUsdMicros: 1_000n,
        limits: {
          maximumCsvRows: 100_000,
          maximumImagePixels: 40_000_000,
          maximumNormalizedTextBytes: 2_000_000,
          maximumOfficeEntries: 10_000,
          maximumPdfPages: 500,
        },
        mediaType: "text/plain",
        sha256: sourceSha256,
        taskScope: "normalization-user-file",
      });

      expect(normalized).toEqual({
        normalizedText: "bounded text",
        provenance: {
          mediaType: "text/plain",
          parser: "python-test-v1",
          sourceSha256,
        },
        vendorCost: null,
      });
      expect(sandbox.commands).toEqual(["python3 /workspace/file-task.py"]);
      expect(sandbox.writtenPaths).toEqual([
        "/workspace/file-task.py",
        "/workspace/input.json",
        "/workspace/source.bin",
      ]);
      expect(sandbox.destroyed).toBe(true);
    }),
  );

  it.effect("reconciles an ambiguous analysis without repeating Python execution", () =>
    Effect.gen(function* () {
      const sandbox = new TestFileSandbox({ ok: true, resultText: "recovered analysis" }, true);
      const compute = makeFileCompute(() => sandbox);
      const analysisId = FileAnalysisId.make("sandbox-analysis");
      const first = yield* compute.analyze({
        analysisId,
        mediaType: "text/plain",
        normalizedText: "source text",
        prompt: "Summarize",
        taskScope: "analysis-user-file",
      });
      sandbox.failExecution = false;
      const recovered = yield* compute.reconcileAnalysis("analysis-user-file");
      yield* compute.releaseAnalysis("analysis-user-file");

      expect(first).toEqual({
        _tag: "AnalysisAmbiguous",
        evidence: "Sandbox analysis outcome requires reconciliation",
        vendorCost: null,
      });
      expect(recovered).toEqual({
        _tag: "AnalysisCompleted",
        resultText: "recovered analysis",
        vendorCost: null,
      });
      expect(sandbox.commands).toHaveLength(1);
      expect(sandbox.destroyed).toBe(true);
    }),
  );

  it.effect("reports analysis Sandbox cleanup failure as a typed compute failure", () =>
    Effect.gen(function* () {
      const sandbox = new TestFileSandbox({ ok: true, resultText: "unused" });
      sandbox.failDestroy = true;
      const compute = makeFileCompute(() => sandbox);
      const failure = yield* Effect.flip(compute.releaseAnalysis("analysis-cleanup-failure"));

      expect(failure).toMatchObject({
        _tag: "FileComputeFailed",
        message: "Disposable file compute cleanup failed",
      });
    }),
  );

  it.effect("does not classify sandbox preparation failure as executed analysis", () =>
    Effect.gen(function* () {
      const sandbox = new TestFileSandbox({ ok: true, resultText: "unused" });
      sandbox.failWrite = true;
      const compute = makeFileCompute(() => sandbox);
      const failure = yield* Effect.flip(
        compute.analyze({
          analysisId: FileAnalysisId.make("sandbox-write-failure"),
          mediaType: "text/plain",
          normalizedText: "source text",
          prompt: "Summarize",
          taskScope: "analysis-user-write-failure",
        }),
      );

      expect(failure).toMatchObject({
        _tag: "FileComputeFailed",
        reason: "parser_failure",
      });
      expect(sandbox.commands).toEqual([]);
    }),
  );

  it.effect("reconciles normalization result after an ambiguous execution response", () =>
    Effect.gen(function* () {
      const sandbox = new TestFileSandbox(
        {
          normalizedText: "recovered text",
          ok: true,
          parser: "python-test-v1",
        },
        true,
      );
      const compute = makeFileCompute(() => sandbox);
      const sourceSha256 = digest("c");
      const normalized = yield* compute.normalize({
        bytes: new TextEncoder().encode("source"),
        conservativeVendorUsdMicros: 1_000n,
        limits: {
          maximumCsvRows: 100_000,
          maximumImagePixels: 40_000_000,
          maximumNormalizedTextBytes: 2_000_000,
          maximumOfficeEntries: 10_000,
          maximumPdfPages: 500,
        },
        mediaType: "text/plain",
        sha256: sourceSha256,
        taskScope: "normalization-user-recovery",
      });

      expect(normalized.normalizedText).toBe("recovered text");
      expect(sandbox.commands).toEqual(["python3 /workspace/file-task.py"]);
      expect(sandbox.destroyed).toBe(true);
    }),
  );

  it.effect("stores immutable source bytes with exact R2 digest metadata", () =>
    Effect.gen(function* () {
      const objects = makeR2FileObjects(env.FILES);
      const key = "tests/r2-file-object";
      const bytes = new TextEncoder().encode("r2 source");
      const inspected = yield* inspectFileContent({
        bytes,
        declaredMediaType: "text/plain",
      });

      yield* objects.put(key, bytes, inspected.sha256);
      expect(yield* objects.stat(key)).toEqual({
        byteLength: BigInt(bytes.byteLength),
        sha256: inspected.sha256,
      });
      expect(yield* objects.get(key)).toEqual(bytes);
      yield* objects.delete(key);
      expect(yield* objects.stat(key)).toBeNull();
    }),
  );
  it.effect("normalizes an accepted upload with provenance and records it once", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-service"));
      const objects = new Map<string, Uint8Array>();
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      const result = yield* withFileService(agent, { objects, usage }, (files) =>
        files.upload({
          actionId: "upload-action-1",
          bytes: new TextEncoder().encode("hello from file"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId: FileId.make("service-file-1"),
          fileName: "notes.txt",
          uploadId: FileUploadId.make("service-upload-1"),
        }),
      );
      const replay = yield* withFileService(agent, { objects, usage }, (files) =>
        files.upload({
          actionId: "upload-action-1",
          bytes: new TextEncoder().encode("hello from file"),
          context: exhaustedAuthorizationContext(),
          declaredMediaType: "text/plain",
          fileId: FileId.make("service-file-1"),
          fileName: "notes.txt",
          uploadId: FileUploadId.make("service-upload-1"),
        }),
      );

      expect(result).toMatchObject({
        _tag: "FileReady",
        file: { state: "ready" },
      });
      if (result._tag !== "FileReady") expect.unreachable("upload should be admitted");
      expect(result.file.provenanceJson).toContain('"sourceSha256"');
      expect(replay).toMatchObject({ _tag: "FileReady" });
      expect(usage).toEqual([{ kind: "fileUploads", quantity: 1n, sourceId: "service-file-1" }]);
    }),
  );

  it.effect("checks current ownership authority before returning a ready upload replay", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-ready-recheck"));
      const objects = new Map<string, Uint8Array>();
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      const input = {
        actionId: "upload-ready-recheck",
        bytes: new TextEncoder().encode("ready replay"),
        context: authorizationContext(),
        declaredMediaType: "text/plain",
        fileId: FileId.make("file-ready-recheck"),
        fileName: "ready.txt",
        uploadId: FileUploadId.make("upload-ready-recheck"),
      } as const;
      yield* withFileService(agent, { objects, usage }, (files) => files.upload(input));
      const denied = yield* withFileService(
        agent,
        {
          currentContext: {
            ...authorizationContext(),
            authority: {
              _tag: "RevokedAuthSession",
              authSessionId: AuthSessionId.make("session-files"),
              userId: UserId.make("user-files"),
            },
          },
          objects,
          usage,
        },
        (files) => files.upload(input),
      );

      expect(denied).toMatchObject({
        _tag: "Denied",
        reason: "authorityRevoked",
      });
    }),
  );

  it.effect("retains parser rejection and conservative incurred cost for malicious content", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-malicious"));
      const objects = new Map<string, Uint8Array>();
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      const failure = new FileComputeFailed({
        basis: "conservative",
        message: "The document archive expands beyond its bounded profile",
        reason: "malicious",
        vendorUsdMicros: 700n,
      });
      const rejected = yield* Effect.flip(
        withFileService(agent, { normalizeFailure: failure, objects, usage }, (files) =>
          files.upload({
            actionId: "upload-malicious",
            bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]),
            context: authorizationContext(),
            declaredMediaType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            fileId: FileId.make("file-malicious"),
            fileName: "unsafe.docx",
            uploadId: FileUploadId.make("upload-malicious"),
          }),
        ),
      );
      const stored = yield* inAgent(agent, (store) => store.find(FileId.make("file-malicious")));

      expect(rejected).toEqual(failure);
      expect(stored).toMatchObject({
        normalizationError: "malicious",
        state: "normalization_failed",
      });
      expect(usage).toContainEqual({
        kind: "vendorUsdMicros",
        quantity: 700n,
        sourceId: "file-malicious",
      });
    }),
  );

  it.effect("fails closed when R2 write ambiguity cannot prove the exact bytes", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-r2-ambiguity"));
      const ambiguous = yield* Effect.flip(
        withFileService(
          agent,
          { objects: new Map(), putMode: "ambiguous-mismatch", usage: [] },
          (files) =>
            files.upload({
              actionId: "upload-r2-ambiguous",
              bytes: new TextEncoder().encode("ambiguous"),
              context: authorizationContext(),
              declaredMediaType: "text/plain",
              fileId: FileId.make("file-r2-ambiguous"),
              fileName: "ambiguous.txt",
              uploadId: FileUploadId.make("upload-r2-ambiguous"),
            }),
        ),
      );

      expect(ambiguous).toMatchObject({
        _tag: "FileStorageAmbiguous",
        operation: "put",
      });
    }),
  );

  it.effect("recovers ambiguous analysis before retry and deletes its full lineage", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-analysis-recovery"),
      );
      const objects = new Map<string, Uint8Array>();
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      const analysisResults: Array<FileAnalysisComputeResult> = [
        {
          _tag: "AnalysisAmbiguous",
          evidence: "compute outcome unavailable",
          vendorCost: null,
        },
        {
          _tag: "AnalysisCompleted",
          resultText: "Recovered answer with source provenance",
          vendorCost: { basis: "observed", quantity: 500n },
        },
      ];
      const shared = { analysisResults, objects, usage };
      yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-analysis",
          bytes: new TextEncoder().encode("analyze me"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId: FileId.make("file-analysis"),
          fileName: "analysis.txt",
          uploadId: FileUploadId.make("upload-analysis"),
        }),
      );
      const first = yield* withFileService(agent, shared, (files) =>
        files.analyze({
          actionId: "analyze-action",
          analysisId: FileAnalysisId.make("analysis-1"),
          context: authorizationContext(),
          fileId: FileId.make("file-analysis"),
          prompt: "Summarize the file",
        }),
      );
      const recovered = yield* withFileService(agent, shared, (files) =>
        files.analyze({
          actionId: "analyze-action",
          analysisId: FileAnalysisId.make("analysis-1"),
          context: exhaustedAuthorizationContext(),
          fileId: FileId.make("file-analysis"),
          prompt: "Summarize the file",
        }),
      );
      const approvedContext: AuthorizationContext = {
        ...authorizationContext(),
        approval: {
          actionId: "delete-action",
          operation: "file.delete",
          userId: UserId.make("user-files"),
        },
      };
      const deleted = yield* withFileService(agent, shared, (files) =>
        files.remove({
          actionId: "delete-action",
          context: approvedContext,
          fileId: FileId.make("file-analysis"),
        }),
      );
      const replayedDeletion = yield* withFileService(agent, shared, (files) =>
        files.remove({
          actionId: "delete-action",
          context: approvedContext,
          fileId: FileId.make("file-analysis"),
        }),
      );
      const deletedUploadReplay = yield* Effect.flip(
        withFileService(agent, shared, (files) =>
          files.upload({
            actionId: "upload-analysis",
            bytes: new TextEncoder().encode("analyze me"),
            context: authorizationContext(),
            declaredMediaType: "text/plain",
            fileId: FileId.make("file-analysis"),
            fileName: "analysis.txt",
            uploadId: FileUploadId.make("upload-analysis"),
          }),
        ),
      );

      expect(first).toMatchObject({
        state: "ambiguous",
        vendorUsdMicros: null,
      });
      expect(recovered).toMatchObject({
        state: "completed",
        resultText: "Recovered answer with source provenance",
      });
      expect(deleted).toMatchObject({
        actionId: "delete-action",
        analysisCount: 1,
        fileId: "file-analysis",
      });
      expect(replayedDeletion).toEqual(deleted);
      expect(deletedUploadReplay).toMatchObject({
        _tag: "FileContentUnavailable",
      });
      expect(objects.size).toBe(0);
      expect(objects.size).toBe(0);
      expect(usage.filter(({ kind }) => kind === "vendorUsdMicros")).toEqual([
        { kind: "vendorUsdMicros", quantity: 500n, sourceId: "analysis-1" },
      ]);
    }),
  );

  it.effect("ends unresolved analysis reconciliation with conservative cost evidence", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-analysis-unresolved"),
      );
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      const shared = {
        analysisResults: [
          {
            _tag: "AnalysisAmbiguous" as const,
            evidence: "execution uncertain",
            vendorCost: null,
          },
          {
            _tag: "AnalysisAmbiguous" as const,
            evidence: "result unavailable",
            vendorCost: null,
          },
        ],
        objects: new Map<string, Uint8Array>(),
        usage,
      };
      yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-unresolved",
          bytes: new TextEncoder().encode("unresolved source"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId: FileId.make("file-analysis-unresolved"),
          fileName: "unresolved.txt",
          uploadId: FileUploadId.make("upload-analysis-unresolved"),
        }),
      );
      const first = yield* withFileService(agent, shared, (files) =>
        files.analyze({
          actionId: "analyze-unresolved",
          analysisId: FileAnalysisId.make("analysis-unresolved"),
          context: authorizationContext(),
          fileId: FileId.make("file-analysis-unresolved"),
          prompt: "Summarize",
        }),
      );
      const terminal = yield* withFileService(agent, shared, (files) =>
        files.analyze({
          actionId: "analyze-unresolved",
          analysisId: FileAnalysisId.make("analysis-unresolved"),
          context: exhaustedAuthorizationContext(),
          fileId: FileId.make("file-analysis-unresolved"),
          prompt: "Summarize",
        }),
      );

      expect(first).toMatchObject({ state: "ambiguous" });
      expect(terminal).toMatchObject({
        state: "failed",
        vendorUsdMicros: 30_000n,
      });
      expect(usage).toContainEqual({
        kind: "vendorUsdMicros",
        quantity: 30_000n,
        sourceId: "analysis-unresolved",
      });
    }),
  );

  it.effect("blocks new Free uploads after downgrade while retained data stays readable", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-downgrade"));
      const catalog = catalogWithRetainedLimits({
        adventurer: 200n,
        free: 100n,
      });
      const objects = new Map<string, Uint8Array>();
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      const shared = { catalog, objects, usage };
      yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-before-downgrade",
          bytes: new TextEncoder().encode("x".repeat(101)),
          context: authorizationContext("adventurer"),
          declaredMediaType: "text/plain",
          fileId: FileId.make("file-excess"),
          fileName: "retained.txt",
          uploadId: FileUploadId.make("upload-excess"),
        }),
      );
      const denied = yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-after-downgrade",
          bytes: new TextEncoder().encode("x"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId: FileId.make("file-after-downgrade"),
          fileName: "new.txt",
          uploadId: FileUploadId.make("upload-after-downgrade"),
        }),
      );
      const readable = yield* withFileService(agent, shared, (files) =>
        files.read({
          actionId: "read-after-downgrade",
          context: authorizationContext(),
          fileId: FileId.make("file-excess"),
        }),
      );

      expect(denied).toMatchObject({
        _tag: "Denied",
        reason: "liveResourceLimitReached",
      });
      expect(readable).toMatchObject({
        _tag: "FileRead",
        file: { fileId: "file-excess" },
      });
    }),
  );

  it.effect("finishes an admitted upload after the current Plan size cap becomes smaller", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-admitted-downgrade"),
      );
      const catalog = catalogWithRetainedLimits({
        adventurer: 200n,
        adventurerUploadBytes: 200n,
        free: 100n,
        freeUploadBytes: 100n,
      });
      const objects = new Map<string, Uint8Array>();
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      const revoked = {
        ...authorizationContext("adventurer"),
        authority: {
          _tag: "RevokedAuthSession" as const,
          authSessionId: AuthSessionId.make("session-files"),
          userId: UserId.make("user-files"),
        },
      };
      const input = {
        actionId: "upload-admitted-downgrade",
        bytes: new TextEncoder().encode("x".repeat(101)),
        context: authorizationContext("adventurer"),
        declaredMediaType: "text/plain",
        fileId: FileId.make("file-admitted-downgrade"),
        fileName: "admitted.txt",
        uploadId: FileUploadId.make("upload-admitted-downgrade"),
      } as const;
      const interrupted = yield* withFileService(
        agent,
        {
          catalog,
          currentContexts: [
            authorizationContext("adventurer"),
            authorizationContext("adventurer"),
            revoked,
          ],
          objects,
          usage,
        },
        (files) => files.upload(input),
      );
      const completed = yield* withFileService(
        agent,
        {
          catalog,
          currentContext: authorizationContext("free"),
          objects,
          usage,
        },
        (files) => files.upload({ ...input, context: authorizationContext("free") }),
      );

      expect(interrupted).toMatchObject({
        _tag: "Denied",
        reason: "authorityRevoked",
      });
      expect(completed).toMatchObject({
        _tag: "FileReady",
        file: { state: "ready" },
      });
      expect(usage).toEqual([
        {
          kind: "fileUploads",
          quantity: 1n,
          sourceId: "file-admitted-downgrade",
        },
      ]);
    }),
  );

  it.effect("accepts one upload identity once and enforces retained bytes atomically", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-retention"));
      const first = yield* inAgent(agent, (store) =>
        store.acceptUpload(
          acceptedInput({
            byteLength: 60n,
            fileId: "file-1",
            uploadId: "upload-1",
          }),
        ),
      );
      const replay = yield* inAgent(agent, (store) =>
        store.acceptUpload(
          acceptedInput({
            acceptedAt: "2026-08-16T12:01:00.000Z",
            byteLength: 60n,
            fileId: "file-1",
            uploadId: "upload-1",
          }),
        ),
      );
      const overLimit = yield* Effect.flip(
        inAgent(agent, (store) =>
          store.acceptUpload(
            acceptedInput({
              byteLength: 41n,
              fileId: "file-2",
              uploadId: "upload-2",
            }),
          ),
        ),
      );

      expect(first._tag).toBe("FileAccepted");
      expect(replay).toEqual({
        _tag: "FileUploadReplayed",
        file: first.file,
      });
      expect(overLimit).toMatchObject({
        _tag: "RetainedFileLimitExceeded",
        attemptedBytes: 41n,
        retainedBytes: 60n,
      });
      expect(yield* inAgent(agent, (store) => store.retainedBytes(UserId.make("user-files")))).toBe(
        60n,
      );
    }),
  );

  it.effect("rejects untrusted normalization provenance", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-provenance"));
      const failure = yield* Effect.flip(
        withFileService(
          agent,
          {
            normalizationProvenance: {
              mediaType: "text/csv",
              parser: "wrong-parser",
              sourceSha256: digest("f"),
            },
            objects: new Map(),
            usage: [],
          },
          (files) =>
            files.upload({
              actionId: "upload-provenance",
              bytes: new TextEncoder().encode("trusted source"),
              context: authorizationContext(),
              declaredMediaType: "text/plain",
              fileId: FileId.make("file-provenance"),
              fileName: "source.txt",
              uploadId: FileUploadId.make("upload-provenance"),
            }),
        ),
      );

      expect(failure).toMatchObject({
        _tag: "FileComputeFailed",
        reason: "parser_failure",
      });
    }),
  );

  it.effect("records failed analysis cost and does not repeat the same identity", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-analysis-failure"),
      );
      const objects = new Map<string, Uint8Array>();
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      const failure = new FileComputeFailed({
        basis: "observed",
        message: "The bounded analysis process failed",
        reason: "parser_failure",
        vendorUsdMicros: 400n,
      });
      const analysisCalls = { analyze: 0, reconcile: 0, release: 0 };
      const shared = {
        analysisCalls,
        analysisFailure: failure,
        objects,
        usage,
      };
      yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-analysis-failure",
          bytes: new TextEncoder().encode("analyze failure"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId: FileId.make("file-analysis-failure"),
          fileName: "failure.txt",
          uploadId: FileUploadId.make("upload-analysis-failure"),
        }),
      );
      const first = yield* Effect.flip(
        withFileService(agent, shared, (files) =>
          files.analyze({
            actionId: "analyze-failure",
            analysisId: FileAnalysisId.make("analysis-failure"),
            context: authorizationContext(),
            fileId: FileId.make("file-analysis-failure"),
            prompt: "Summarize",
          }),
        ),
      );
      const repeated = yield* withFileService(agent, shared, (files) =>
        files.analyze({
          actionId: "analyze-failure",
          analysisId: FileAnalysisId.make("analysis-failure"),
          context: authorizationContext(),
          fileId: FileId.make("file-analysis-failure"),
          prompt: "Summarize",
        }),
      );

      expect(first).toEqual(failure);
      expect(repeated).toMatchObject({
        state: "failed",
        failure: "parser_failure",
      });
      expect(analysisCalls.release).toBe(1);
      expect(usage).toContainEqual({
        kind: "vendorUsdMicros",
        quantity: 400n,
        sourceId: "analysis-failure",
      });
    }),
  );

  it.effect("retries analysis cleanup before persisting its terminal result", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-analysis-cleanup-retry"),
      );
      const cleanupFailure = new FileComputeFailed({
        basis: null,
        message: "Disposable file compute cleanup failed",
        reason: "parser_failure",
        vendorUsdMicros: 0n,
      });
      const completed = {
        _tag: "AnalysisCompleted" as const,
        resultText: "clean result",
        vendorCost: null,
      };
      const analysisCalls = { analyze: 0, reconcile: 0, release: 0 };
      const shared = {
        analysisCalls,
        analysisResults: [completed],
        objects: new Map<string, Uint8Array>(),
        releaseFailures: [cleanupFailure],
        usage: [],
      };
      const fileId = FileId.make("file-analysis-cleanup-retry");
      yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-analysis-cleanup-retry",
          bytes: new TextEncoder().encode("cleanup retry"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId,
          fileName: "cleanup.txt",
          uploadId: FileUploadId.make("upload-analysis-cleanup-retry"),
        }),
      );
      const request = {
        actionId: "analysis-cleanup-retry",
        analysisId: FileAnalysisId.make("analysis-cleanup-retry"),
        context: authorizationContext(),
        fileId,
        prompt: "Summarize",
      } as const;
      const first = yield* Effect.flip(
        withFileService(agent, shared, (files) => files.analyze(request)),
      );
      const recovered = yield* withFileService(agent, shared, (files) => files.analyze(request));

      expect(first).toEqual(cleanupFailure);
      expect(recovered).toMatchObject({
        resultText: "clean result",
        state: "completed",
      });
      expect(analysisCalls).toEqual({ analyze: 1, reconcile: 0, release: 2 });
    }),
  );

  it.effect("finishes analysis cleanup after authority loss without returning the result", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-analysis-cleanup-denied"),
      );
      const cleanupFailure = new FileComputeFailed({
        basis: null,
        message: "Disposable file compute cleanup failed",
        reason: "parser_failure",
        vendorUsdMicros: 0n,
      });
      const analysisCalls = { analyze: 0, reconcile: 0, release: 0 };
      const shared = {
        analysisCalls,
        analysisResults: [
          {
            _tag: "AnalysisCompleted" as const,
            resultText: "private stored result",
            vendorCost: null,
          },
        ],
        objects: new Map<string, Uint8Array>(),
        releaseFailures: [cleanupFailure],
        usage: [],
      };
      const fileId = FileId.make("file-analysis-cleanup-denied");
      const analysisId = FileAnalysisId.make("analysis-cleanup-denied");
      yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-analysis-cleanup-denied",
          bytes: new TextEncoder().encode("cleanup after authority loss"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId,
          fileName: "cleanup.txt",
          uploadId: FileUploadId.make("upload-analysis-cleanup-denied"),
        }),
      );
      const request = {
        actionId: "analysis-cleanup-denied",
        analysisId,
        context: authorizationContext(),
        fileId,
        prompt: "Summarize",
      } as const;
      const first = yield* Effect.flip(
        withFileService(agent, shared, (files) => files.analyze(request)),
      );
      const revoked = {
        ...authorizationContext(),
        authority: {
          _tag: "RevokedAuthSession" as const,
          authSessionId: AuthSessionId.make("session-files"),
          userId: UserId.make("user-files"),
        },
      };
      const denied = yield* withFileService(
        agent,
        { ...shared, currentContext: revoked },
        (files) => files.analyze(request),
      );
      const recovered = yield* withFileService(agent, shared, (files) => files.analyze(request));

      expect(first).toEqual(cleanupFailure);
      expect(denied).toMatchObject({
        _tag: "Denied",
        reason: "authorityRevoked",
      });
      expect(recovered).toMatchObject({
        resultText: "private stored result",
        state: "completed",
      });
      expect(analysisCalls).toEqual({ analyze: 1, reconcile: 0, release: 2 });
    }),
  );

  it.effect("recovers stored analysis evidence when finalization fails after cleanup", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-analysis-finalize-retry"),
      );
      const analysisCalls = { analyze: 0, reconcile: 0, release: 0 };
      const failAnalysisFinalizationOnce = { value: true };
      const shared = {
        analysisCalls,
        analysisResults: [
          {
            _tag: "AnalysisCompleted" as const,
            resultText: "durable original result",
            vendorCost: { basis: "observed" as const, quantity: 640n },
          },
        ],
        failAnalysisFinalizationOnce,
        objects: new Map<string, Uint8Array>(),
        usage: [],
      };
      const fileId = FileId.make("file-analysis-finalize-retry");
      yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-analysis-finalize-retry",
          bytes: new TextEncoder().encode("finalize retry"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId,
          fileName: "finalize.txt",
          uploadId: FileUploadId.make("upload-analysis-finalize-retry"),
        }),
      );
      const request = {
        actionId: "analysis-finalize-retry",
        analysisId: FileAnalysisId.make("analysis-finalize-retry"),
        context: authorizationContext(),
        fileId,
        prompt: "Summarize",
      } as const;
      const first = yield* Effect.flip(
        withFileService(agent, shared, (files) => files.analyze(request)),
      );
      const recovered = yield* withFileService(agent, shared, (files) => files.analyze(request));

      expect(first).toMatchObject({ _tag: "FileStoreUnavailable" });
      expect(recovered).toMatchObject({
        resultText: "durable original result",
        state: "completed",
        vendorUsdMicros: 640n,
      });
      expect(analysisCalls).toEqual({ analyze: 1, reconcile: 0, release: 2 });
    }),
  );

  it.effect("keeps a file readable when current authority denies deletion", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-delete-recheck"));
      const objects = new Map<string, Uint8Array>();
      const approved = {
        ...authorizationContext(),
        approval: {
          actionId: "delete-recheck",
          operation: "file.delete" as const,
          userId: UserId.make("user-files"),
        },
      };
      const revoked = {
        ...approved,
        authority: {
          _tag: "RevokedAuthSession" as const,
          authSessionId: AuthSessionId.make("session-files"),
          userId: UserId.make("user-files"),
        },
      };
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      yield* withFileService(agent, { objects, usage }, (files) =>
        files.upload({
          actionId: "upload-delete-recheck",
          bytes: new TextEncoder().encode("keep me"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId: FileId.make("file-delete-recheck"),
          fileName: "keep.txt",
          uploadId: FileUploadId.make("upload-delete-recheck"),
        }),
      );
      const denied = yield* withFileService(
        agent,
        { currentContext: revoked, objects, usage },
        (files) =>
          files.remove({
            actionId: "delete-recheck",
            context: approved,
            fileId: FileId.make("file-delete-recheck"),
          }),
      );
      const stored = yield* inAgent(agent, (store) =>
        store.find(FileId.make("file-delete-recheck")),
      );

      expect(denied).toMatchObject({
        _tag: "Denied",
        reason: "authorityRevoked",
      });
      expect(stored.state).toBe("ready");
    }),
  );

  it.effect("keeps a file when exact deletion Approval is invalidated before R2", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-delete-approval"),
      );
      const objects = new Map<string, Uint8Array>();
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      yield* withFileService(agent, { objects, usage }, (files) =>
        files.upload({
          actionId: "upload-delete-approval",
          bytes: new TextEncoder().encode("keep approval"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId: FileId.make("file-delete-approval"),
          fileName: "keep.txt",
          uploadId: FileUploadId.make("upload-delete-approval"),
        }),
      );
      const approved: AuthorizationContext = {
        ...authorizationContext(),
        approval: {
          actionId: "delete-approval",
          operation: "file.delete",
          userId: UserId.make("user-files"),
        },
      };
      const invalidated = {
        ...approved,
        approval: null,
      } satisfies AuthorizationContext;
      const denied = yield* withFileService(
        agent,
        { currentContexts: [approved, invalidated], objects, usage },
        (files) =>
          files.remove({
            actionId: "delete-approval",
            context: approved,
            fileId: FileId.make("file-delete-approval"),
          }),
      );
      const stored = yield* inAgent(agent, (store) =>
        store.find(FileId.make("file-delete-approval")),
      );

      expect(denied).toMatchObject({
        _tag: "Denied",
        reason: "approvalRequired",
      });
      expect(stored.state).toBe("ready");
      expect(objects.size).toBe(1);
    }),
  );

  it.effect("rejects one upload identity when trusted facts change", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-conflict"));
      yield* inAgent(agent, (store) => store.acceptUpload(acceptedInput()));
      const conflict = yield* Effect.flip(
        inAgent(agent, (store) =>
          store.acceptUpload(acceptedInput({ digest: digest("b"), fileName: "changed.txt" })),
        ),
      );

      expect(conflict).toMatchObject({
        _tag: "FileUploadConflict",
        uploadId: "upload-1",
      });
    }),
  );

  it.effect("guards file lifecycle transitions and clears normalized content before deletion", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-state-guards"));
      const fileId = FileId.make("file-state-guards");
      yield* inAgent(agent, (store) =>
        Effect.gen(function* () {
          yield* store.acceptUpload(acceptedInput({ fileId, uploadId: "upload-state-guards" }));
          yield* store.markStored(fileId);
          yield* store.claimNormalization({
            claimedAt: DbTimestamp.make("2026-08-16T12:00:00.000Z"),
            expectedClaimedAt: null,
            fileId,
          });
          yield* store.completeNormalization(
            fileId,
            DbTimestamp.make("2026-08-16T12:00:00.000Z"),
            "normalized",
            '{"parser":"test"}',
          );
          yield* store.markDeleting(fileId);
        }),
      );
      const deleting = yield* inAgent(agent, (store) => store.find(fileId));
      yield* inAgent(agent, (store) =>
        store.completeDeletion({
          actionId: "delete-state-guards",
          deletedAt: DbTimestamp.make("2026-08-16T12:01:00.000Z"),
          fileId,
        }),
      );
      const invalidRestart = yield* Effect.flip(
        inAgent(agent, (store) => store.markStored(fileId)),
      );

      expect(deleting).toMatchObject({
        normalizationError: null,
        normalizedText: null,
        provenanceJson: null,
        state: "deleting",
      });
      expect(invalidRestart).toMatchObject({
        _tag: "FileStateTransitionConflict",
        currentState: "deleted",
        operation: "markStored",
      });
    }),
  );

  it.effect("grants one durable execution claim for one analysis identity", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-analysis-claim"));
      const claims = yield* inAgent(agent, (store) =>
        Effect.gen(function* () {
          const fileId = FileId.make("file-analysis-claim");
          yield* store.acceptUpload(acceptedInput({ fileId, uploadId: "upload-analysis-claim" }));
          yield* store.markStored(fileId);
          yield* store.claimNormalization({
            claimedAt: DbTimestamp.make("2026-08-16T12:00:00.000Z"),
            expectedClaimedAt: null,
            fileId,
          });
          yield* store.completeNormalization(
            fileId,
            DbTimestamp.make("2026-08-16T12:00:00.000Z"),
            "normalized",
            '{"parser":"test"}',
          );
          yield* store.beginAnalysis({
            allowancePeriodId: AllowancePeriodId.make("allowance-files"),
            analysisId: FileAnalysisId.make("analysis-claim"),
            createdAt: DbTimestamp.make("2026-08-16T12:00:00.000Z"),
            fileId,
            prompt: "Summarize",
          });
          return yield* Effect.all(
            [
              store.claimAnalysis(
                FileAnalysisId.make("analysis-claim"),
                DbTimestamp.make("2026-08-16T12:00:01.000Z"),
              ),
              store.claimAnalysis(
                FileAnalysisId.make("analysis-claim"),
                DbTimestamp.make("2026-08-16T12:00:01.000Z"),
              ),
            ],
            { concurrency: 2 },
          );
        }),
      );

      expect(claims).toEqual([true, false]);
    }),
  );

  it.effect("does not reconcile while the claimed analysis execution is active", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-analysis-active"),
      );
      const objects = new Map<string, Uint8Array>();
      const usage: Array<{
        readonly kind: string;
        readonly quantity: bigint;
        readonly sourceId: string;
      }> = [];
      yield* withFileService(agent, { objects, usage }, (files) =>
        files.upload({
          actionId: "upload-analysis-active",
          bytes: new TextEncoder().encode("active analysis"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId: FileId.make("file-analysis-active"),
          fileName: "active.txt",
          uploadId: FileUploadId.make("upload-analysis-active"),
        }),
      );
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const analysisCalls = { analyze: 0, reconcile: 0 };
      const request = {
        actionId: "analyze-active",
        analysisId: FileAnalysisId.make("analysis-active"),
        context: authorizationContext(),
        fileId: FileId.make("file-analysis-active"),
        prompt: "Summarize",
      } as const;
      const results = yield* withFileService(
        agent,
        {
          analysisCalls,
          analysisEffect: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              _tag: "AnalysisCompleted" as const,
              resultText: "one result",
              vendorCost: null,
            }),
          ),
          objects,
          usage,
        },
        (files) =>
          Effect.gen(function* () {
            const first = yield* files.analyze(request).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            const retry = yield* files.analyze(request);
            yield* Deferred.succeed(release, undefined);
            return { completed: yield* Fiber.join(first), retry };
          }),
      );

      expect(results.retry).toMatchObject({
        failure: fileAnalysisExecutionPending,
        state: "ambiguous",
      });
      expect(results.completed).toMatchObject({
        resultText: "one result",
        state: "completed",
      });
      expect(analysisCalls).toEqual({ analyze: 1, reconcile: 0 });
    }),
  );

  it.effect("runs one normalization for concurrent retries of one upload identity", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-normalization-active"),
      );
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const normalizationCalls = { count: 0 };
      const objects = new Map<string, Uint8Array>();
      const request = {
        actionId: "upload-normalization-active",
        bytes: new TextEncoder().encode("active normalize"),
        context: authorizationContext(),
        declaredMediaType: "text/plain",
        fileId: FileId.make("file-normalization-active"),
        fileName: "active.txt",
        uploadId: FileUploadId.make("upload-normalization-active"),
      } as const;
      const results = yield* withFileService(
        agent,
        {
          normalizationCalls,
          normalizationEffect: ({ mediaType, sha256 }) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                normalizedText: "one normalization",
                provenance: {
                  mediaType,
                  parser: "test-parser-v1",
                  sourceSha256: sha256,
                },
                vendorCost: null,
              }),
            ),
          objects,
          usage: [],
        },
        (files) =>
          Effect.gen(function* () {
            const first = yield* files.upload(request).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            const retry = yield* files.upload(request);
            yield* Deferred.succeed(release, undefined);
            return { completed: yield* Fiber.join(first), retry };
          }),
      );

      expect(results.retry).toMatchObject({
        _tag: "FileNormalizationPending",
        file: { state: "normalizing" },
      });
      expect(results.completed).toMatchObject({
        _tag: "FileReady",
        file: { state: "ready" },
      });
      expect(normalizationCalls.count).toBe(1);
    }),
  );

  it.effect("reclaims a stale normalization execution after its bounded lease", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-normalization-stale"),
      );
      const bytes = new TextEncoder().encode("stale normalize");
      const inspected = yield* inspectFileContent({
        bytes,
        declaredMediaType: "text/plain",
      });
      const fileId = FileId.make("file-normalization-stale");
      yield* inAgent(agent, (store) =>
        Effect.gen(function* () {
          yield* store.acceptUpload({
            acceptedAt: DbTimestamp.make("2026-08-16T11:58:00.000Z"),
            allowancePeriodId: AllowancePeriodId.make("allowance-files"),
            byteLength: inspected.byteLength,
            fileId,
            fileName: "stale.txt",
            mediaType: inspected.mediaType,
            objectKey: "users/user-files/files/file-normalization-stale/source",
            retainedByteLimit: 100_000_000n,
            sha256: inspected.sha256,
            uploadId: FileUploadId.make("upload-normalization-stale"),
            userId: UserId.make("user-files"),
          });
          yield* store.markStored(fileId);
          yield* store.claimNormalization({
            claimedAt: DbTimestamp.make("2026-08-16T11:58:00.000Z"),
            expectedClaimedAt: null,
            fileId,
          });
        }),
      );
      const recovered = yield* withFileService(
        agent,
        { objects: new Map<string, Uint8Array>(), usage: [] },
        (files) =>
          files.upload({
            actionId: "upload-normalization-stale",
            bytes,
            context: authorizationContext(),
            declaredMediaType: "text/plain",
            fileId,
            fileName: "stale.txt",
            uploadId: FileUploadId.make("upload-normalization-stale"),
          }),
      );

      expect(recovered).toMatchObject({
        _tag: "FileReady",
        file: { state: "ready" },
      });
    }),
  );

  it.effect("fences a stale normalization worker after a newer claim takes over", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-normalization-fence"),
      );
      const fileId = FileId.make("file-normalization-fence");
      const oldClaim = DbTimestamp.make("2026-08-16T11:58:00.000Z");
      const newClaim = DbTimestamp.make("2026-08-16T12:00:00.000Z");
      const outcome = yield* inAgent(agent, (store) =>
        Effect.gen(function* () {
          yield* store.acceptUpload(
            acceptedInput({ fileId, uploadId: "upload-normalization-fence" }),
          );
          yield* store.markStored(fileId);
          yield* store.claimNormalization({
            claimedAt: oldClaim,
            expectedClaimedAt: null,
            fileId,
          });
          yield* store.claimNormalization({
            claimedAt: newClaim,
            expectedClaimedAt: oldClaim,
            fileId,
          });
          const stale = yield* Effect.flip(
            store.completeNormalization(fileId, oldClaim, "stale", '{"parser":"stale"}'),
          );
          yield* store.completeNormalization(fileId, newClaim, "winner", '{"parser":"winner"}');
          return { file: yield* store.find(fileId), stale };
        }),
      );

      expect(outcome.stale).toMatchObject({
        _tag: "FileStateTransitionConflict",
        currentState: "normalizing",
      });
      expect(outcome.file).toMatchObject({
        normalizedText: "winner",
        state: "ready",
      });
    }),
  );

  it.effect("releases ambiguous analysis compute when its source file is deleted", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-analysis-delete-release"),
      );
      const analysisCalls = { analyze: 0, reconcile: 0, release: 0 };
      const objects = new Map<string, Uint8Array>();
      const shared = {
        analysisCalls,
        analysisResults: [
          {
            _tag: "AnalysisAmbiguous" as const,
            evidence: "still running",
            vendorCost: null,
          },
        ],
        objects,
        usage: [],
      };
      const fileId = FileId.make("file-analysis-delete-release");
      yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-analysis-delete-release",
          bytes: new TextEncoder().encode("delete analysis"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId,
          fileName: "delete.txt",
          uploadId: FileUploadId.make("upload-analysis-delete-release"),
        }),
      );
      yield* withFileService(agent, shared, (files) =>
        files.analyze({
          actionId: "analysis-delete-release",
          analysisId: FileAnalysisId.make("analysis-delete-release"),
          context: authorizationContext(),
          fileId,
          prompt: "Summarize",
        }),
      );
      const approved = {
        ...authorizationContext(),
        approval: {
          actionId: "delete-analysis-release",
          operation: "file.delete" as const,
          userId: UserId.make("user-files"),
        },
      };
      yield* withFileService(agent, shared, (files) =>
        files.remove({
          actionId: "delete-analysis-release",
          context: approved,
          fileId,
        }),
      );

      expect(analysisCalls.release).toBe(1);
    }),
  );

  it.effect("retries failed analysis cleanup before completing file deletion", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-delete-cleanup-retry"),
      );
      const cleanupFailure = new FileComputeFailed({
        basis: null,
        message: "Disposable file compute cleanup failed",
        reason: "parser_failure",
        vendorUsdMicros: 0n,
      });
      const objects = new Map<string, Uint8Array>();
      const shared = {
        analysisResults: [
          {
            _tag: "AnalysisAmbiguous" as const,
            evidence: "still running",
            vendorCost: null,
          },
        ],
        objects,
        releaseFailures: [cleanupFailure],
        usage: [],
      };
      const fileId = FileId.make("file-delete-cleanup-retry");
      yield* withFileService(agent, shared, (files) =>
        files.upload({
          actionId: "upload-delete-cleanup-retry",
          bytes: new TextEncoder().encode("delete cleanup retry"),
          context: authorizationContext(),
          declaredMediaType: "text/plain",
          fileId,
          fileName: "delete.txt",
          uploadId: FileUploadId.make("upload-delete-cleanup-retry"),
        }),
      );
      yield* withFileService(agent, shared, (files) =>
        files.analyze({
          actionId: "analysis-delete-cleanup-retry",
          analysisId: FileAnalysisId.make("analysis-delete-cleanup-retry"),
          context: authorizationContext(),
          fileId,
          prompt: "Summarize",
        }),
      );
      const approved = {
        ...authorizationContext(),
        approval: {
          actionId: "delete-cleanup-retry",
          operation: "file.delete" as const,
          userId: UserId.make("user-files"),
        },
      };
      const first = yield* Effect.flip(
        withFileService(agent, shared, (files) =>
          files.remove({
            actionId: "delete-cleanup-retry",
            context: approved,
            fileId,
          }),
        ),
      );
      const retained = yield* inAgent(agent, (store) => store.find(fileId));
      const recovered = yield* withFileService(agent, shared, (files) =>
        files.remove({
          actionId: "delete-cleanup-retry",
          context: approved,
          fileId,
        }),
      );

      expect(first).toEqual(cleanupFailure);
      expect(retained.state).toBe("deleting");
      expect(recovered).toMatchObject({ fileId });
      expect(objects.size).toBe(0);
    }),
  );

  it.effect("removes an R2 write when deletion wins the file-state transition", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(
        AgentId.make("agent-files-upload-delete-race"),
      );
      const objects = new Map<string, Uint8Array>();
      const fileId = FileId.make("file-upload-delete-race");
      const failure = yield* Effect.flip(
        withFileService(
          agent,
          {
            beforePut: (store) =>
              Effect.gen(function* () {
                yield* store.markDeleting(fileId);
                yield* store.completeDeletion({
                  actionId: "delete-upload-race",
                  deletedAt: DbTimestamp.make("2026-08-16T12:02:00.000Z"),
                  fileId,
                });
              }),
            objects,
            usage: [],
          },
          (files) =>
            files.upload({
              actionId: "upload-delete-race",
              bytes: new TextEncoder().encode("race source"),
              context: authorizationContext(),
              declaredMediaType: "text/plain",
              fileId,
              fileName: "race.txt",
              uploadId: FileUploadId.make("upload-delete-race"),
            }),
        ),
      );
      const stored = yield* inAgent(agent, (store) => store.find(fileId));

      expect(failure).toMatchObject({ _tag: "FileStateTransitionConflict" });
      expect(stored.state).toBe("deleted");
      expect(objects.size).toBe(0);
    }),
  );

  it.effect("reconciles both outcomes of an ambiguous cleanup delete", () =>
    Effect.forEach(
      [
        {
          deleteMode: "apply-then-fail" as const,
          expectedTag: "FileStateTransitionConflict",
          size: 0,
        },
        {
          deleteMode: "fail-retained" as const,
          expectedTag: "FileStorageAmbiguous",
          size: 1,
        },
      ],
      ({ deleteMode, expectedTag, size }) =>
        Effect.gen(function* () {
          const suffix = deleteMode === "apply-then-fail" ? "missing" : "retained";
          const agent = env.OSFO_AGENT_TEST_FACET.getByName(
            AgentId.make(`agent-files-cleanup-${suffix}`),
          );
          const objects = new Map<string, Uint8Array>();
          const fileId = FileId.make(`file-cleanup-${suffix}`);
          const failure = yield* Effect.flip(
            withFileService(
              agent,
              {
                beforePut: (store) =>
                  Effect.gen(function* () {
                    yield* store.markDeleting(fileId);
                    yield* store.completeDeletion({
                      actionId: `delete-cleanup-${suffix}`,
                      deletedAt: DbTimestamp.make("2026-08-16T12:03:00.000Z"),
                      fileId,
                    });
                  }),
                deleteMode,
                objects,
                usage: [],
              },
              (files) =>
                files.upload({
                  actionId: `upload-cleanup-${suffix}`,
                  bytes: new TextEncoder().encode("cleanup source"),
                  context: authorizationContext(),
                  declaredMediaType: "text/plain",
                  fileId,
                  fileName: "cleanup.txt",
                  uploadId: FileUploadId.make(`upload-cleanup-${suffix}`),
                }),
            ),
          );

          expect(failure).toMatchObject({ _tag: expectedTag });
          expect(objects.size).toBe(size);
        }),
      { discard: true },
    ),
  );

  it.effect("retries retained R2 cleanup from completed deletion lineage", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-cleanup-retry"));
      const objects = new Map<string, Uint8Array>();
      const fileId = FileId.make("file-cleanup-retry");
      yield* Effect.flip(
        withFileService(
          agent,
          {
            beforePut: (store) =>
              Effect.gen(function* () {
                yield* store.markDeleting(fileId);
                yield* store.completeDeletion({
                  actionId: "delete-cleanup-retry",
                  deletedAt: DbTimestamp.make("2026-08-16T12:03:00.000Z"),
                  fileId,
                });
              }),
            deleteMode: "fail-retained",
            objects,
            usage: [],
          },
          (files) =>
            files.upload({
              actionId: "upload-cleanup-retry",
              bytes: new TextEncoder().encode("cleanup source"),
              context: authorizationContext(),
              declaredMediaType: "text/plain",
              fileId,
              fileName: "cleanup.txt",
              uploadId: FileUploadId.make("upload-cleanup-retry"),
            }),
        ),
      );
      const approved = {
        ...authorizationContext(),
        approval: {
          actionId: "delete-cleanup-retry",
          operation: "file.delete" as const,
          userId: UserId.make("user-files"),
        },
      };
      const lineage = yield* withFileService(
        agent,
        { deleteMode: "success", objects, usage: [] },
        (files) =>
          files.remove({
            actionId: "delete-cleanup-retry",
            context: approved,
            fileId,
          }),
      );

      expect(lineage).toMatchObject({
        actionId: "delete-cleanup-retry",
        fileId,
      });
      expect(objects.size).toBe(0);
    }),
  );

  it.effect("preserves the valid source when another retry reaches ready first", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(AgentId.make("agent-files-ready-race"));
      const objects = new Map<string, Uint8Array>();
      const fileId = FileId.make("file-ready-race");
      const result = yield* withFileService(
        agent,
        {
          afterPut: (store) =>
            Effect.gen(function* () {
              yield* store.markStored(fileId);
              yield* store.claimNormalization({
                claimedAt: DbTimestamp.make("2026-08-16T12:00:00.000Z"),
                expectedClaimedAt: null,
                fileId,
              });
              yield* store.completeNormalization(
                fileId,
                DbTimestamp.make("2026-08-16T12:00:00.000Z"),
                "winner",
                '{"parser":"winner"}',
              );
            }),
          objects,
          usage: [],
        },
        (files) =>
          files.upload({
            actionId: "upload-ready-race",
            bytes: new TextEncoder().encode("ready source"),
            context: authorizationContext(),
            declaredMediaType: "text/plain",
            fileId,
            fileName: "ready.txt",
            uploadId: FileUploadId.make("upload-ready-race"),
          }),
      );

      expect(result).toMatchObject({
        _tag: "FileReady",
        file: { state: "ready" },
      });
      expect(objects.size).toBe(1);
    }),
  );
});

const withFileService = <A, E>(
  agent: DurableObjectStub<OsfoAgent>,
  state: {
    readonly analysisCalls?: {
      analyze: number;
      reconcile: number;
      release?: number;
    };
    readonly analysisEffect?: Effect.Effect<FileAnalysisComputeResult, FileComputeFailed>;
    readonly analysisResults?: Array<FileAnalysisComputeResult>;
    readonly analysisFailure?: FileComputeFailed;
    readonly afterPut?: (
      store: ReturnType<typeof makeFileStore>,
    ) => Effect.Effect<void, TestPersistenceError>;
    readonly beforePut?: (
      store: ReturnType<typeof makeFileStore>,
    ) => Effect.Effect<void, TestPersistenceError>;
    readonly catalog?: PlanPolicyCatalog;
    readonly currentContext?: AuthorizationContext;
    readonly currentContexts?: Array<AuthorizationContext>;
    readonly deleteMode?: "apply-then-fail" | "fail-retained" | "success";
    readonly failAnalysisFinalizationOnce?: { value: boolean };
    readonly normalizationCalls?: { count: number };
    readonly normalizationEffect?: FileCompute["normalize"];
    readonly normalizationProvenance?: {
      readonly mediaType: "text/csv";
      readonly parser: string;
      readonly sourceSha256: FileDigest;
    };
    readonly normalizeFailure?: FileComputeFailed;
    readonly objects: Map<string, Uint8Array>;
    readonly putMode?: "ambiguous-mismatch" | "success";
    readonly releaseFailures?: Array<FileComputeFailed>;
    readonly usage: Array<{
      readonly kind: string;
      readonly quantity: bigint;
      readonly sourceId: string;
    }>;
  },
  operation: (files: TestFiles) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.promise(() =>
    runInDurableObject(agent, async (_instance, durableState) => {
      const catalog = state.catalog ?? retainedCatalog;
      const store = makeFileStore(makeAgentDb(durableState.storage));
      const persistence = {
        ...store,
        updateAnalysis: (input: Parameters<typeof store.updateAnalysis>[0]) => {
          if (
            state.failAnalysisFinalizationOnce?.value === true &&
            (input.state === "completed" || input.state === "failed")
          ) {
            state.failAnalysisFinalizationOnce.value = false;
            return new FileStoreUnavailable({
              cause: "test finalization failure",
              message: "The test Agent SQLite finalization failed",
              operation: "updateAnalysis",
            });
          }
          return store.updateAnalysis(input);
        },
      };
      const files = makeFiles<
        never,
        never,
        TestObjectUnavailable | TestPersistenceError,
        TestPersistenceError
      >({
        allowances: {
          record: (_periodId, source, items) => {
            for (const item of items) {
              const recorded = {
                kind: item.allowanceKind,
                quantity: item.quantity,
                sourceId: source.sourceId,
              };
              if (
                !state.usage.some(
                  (candidate) =>
                    candidate.kind === recorded.kind && candidate.sourceId === recorded.sourceId,
                )
              )
                state.usage.push(recorded);
            }
            return Effect.succeed({ _tag: "Recorded" as const });
          },
        },
        authorization: Authorization.make(catalog),
        catalog,
        compute: {
          analyze: () => {
            if (state.analysisCalls !== undefined) state.analysisCalls.analyze += 1;
            return (
              state.analysisEffect ??
              state.analysisFailure ??
              nextAnalysisResult(state.analysisResults)
            );
          },
          normalize: (input) => {
            if (state.normalizationCalls !== undefined) state.normalizationCalls.count += 1;
            if (state.normalizationEffect !== undefined) return state.normalizationEffect(input);
            return state.normalizeFailure === undefined
              ? Effect.succeed({
                  normalizedText: "hello from file",
                  provenance: state.normalizationProvenance ?? {
                    parser: "test-parser-v1",
                    mediaType: input.mediaType,
                    sourceSha256: input.sha256,
                  },
                  vendorCost: null,
                })
              : state.normalizeFailure;
          },
          releaseAnalysis: () => {
            if (state.analysisCalls?.release !== undefined) state.analysisCalls.release += 1;
            return state.releaseFailures?.shift() ?? Effect.void;
          },
          reconcileAnalysis: () => {
            if (state.analysisCalls !== undefined) state.analysisCalls.reconcile += 1;
            return nextAnalysisResult(state.analysisResults);
          },
        },
        currentAuthorizationContext: (context) =>
          Effect.succeed(state.currentContexts?.shift() ?? state.currentContext ?? context),
        now: Effect.succeed(DbTimestamp.make("2026-08-16T12:00:00.000Z")),
        objects: {
          delete: (key) => {
            if (state.deleteMode === "fail-retained") {
              return new TestObjectUnavailable({
                message: "The test R2 delete is ambiguous",
              });
            }
            if (state.deleteMode === "apply-then-fail") {
              state.objects.delete(key);
              return new TestObjectUnavailable({
                message: "The test R2 delete response was lost",
              });
            }
            return Effect.sync(() => void state.objects.delete(key));
          },
          get: (key) => Effect.succeed(state.objects.get(key) ?? null),
          put: (key, bytes) =>
            state.putMode === "ambiguous-mismatch"
              ? new TestObjectUnavailable({
                  message: "The test R2 put is ambiguous",
                })
              : Effect.gen(function* () {
                  if (state.beforePut !== undefined) yield* state.beforePut(store);
                  state.objects.set(key, Uint8Array.from(bytes));
                  if (state.afterPut !== undefined) yield* state.afterPut(store);
                }),
          stat: (key) => {
            const bytes = state.objects.get(key);
            return Effect.succeed(
              bytes === undefined
                ? null
                : {
                    byteLength: BigInt(bytes.byteLength),
                    sha256: digestForBytes(bytes),
                  },
            );
          },
        },
        store: persistence,
      });
      return await Effect.runPromiseExit(operation(files));
    }),
  ).pipe(Effect.flatMap(Exit.match({ onFailure: Effect.failCause, onSuccess: Effect.succeed })));

type TestPersistenceError =
  | FileAnalysisConflict
  | FileNotFound
  | FileStoreRecordInvalid
  | FileStoreUnavailable
  | FileStateTransitionConflict
  | FileUploadConflict
  | RetainedFileLimitExceeded;

type TestFiles = ReturnType<
  typeof makeFiles<never, never, TestObjectUnavailable | TestPersistenceError, TestPersistenceError>
>;

const authorizationContext = (plan: "adventurer" | "free" = "free"): AuthorizationContext => ({
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("allowance-files"),
    endsAt: new Date("2026-09-01T00:00:00.000Z"),
    plan,
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: new Date("2026-08-01T00:00:00.000Z"),
    usage: [],
  },
  approval: null,
  authority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("session-files"),
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    userId: UserId.make("user-files"),
  },
  deletionAccess: { _tag: "DeletionAccessAvailable" },
  gmailConnection: null,
  liveFacts: {
    activeGmSummonsInSession: 0n,
    activeReminders: 0n,
    concurrentWorkflows: 0n,
    retainedFileBytes: 0n,
  },
  now: new Date("2026-08-16T12:00:00.000Z"),
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("session-files"),
  },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: UserId.make("user-files"),
  subscription: {
    plan,
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
  },
  user: { _tag: "ActiveUser", userId: UserId.make("user-files") },
});

const exhaustedAuthorizationContext = (): AuthorizationContext => ({
  ...authorizationContext(),
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("allowance-files"),
    endsAt: new Date("2026-09-01T00:00:00.000Z"),
    plan: "free",
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: new Date("2026-08-01T00:00:00.000Z"),
    usage: [{ allowanceKind: "fileUploads", quantity: 10n }],
  },
});

const digestForBytes = (bytes: Uint8Array): FileDigest => {
  // Test object storage uses the source content digest supplied by this fixed fixture.
  return bytes.byteLength === 15 ? digest("2") : digest("3");
};

const nextAnalysisResult = (
  results: Array<FileAnalysisComputeResult> | undefined,
): Effect.Effect<FileAnalysisComputeResult, FileComputeFailed> => {
  const next = results?.shift();
  return next === undefined
    ? new FileComputeFailed({
        basis: null,
        message: "No test analysis result is configured",
        reason: "parser_failure",
        vendorUsdMicros: 0n,
      })
    : Effect.succeed(next);
};

class TestObjectUnavailable extends Schema.TaggedError<TestObjectUnavailable>()(
  "TestObjectUnavailable",
  { message: Schema.String },
) {}

class TestFileSandbox {
  readonly commands: Array<string> = [];
  destroyed = false;
  failDestroy = false;
  failWrite = false;
  readonly writtenPaths: Array<string> = [];

  constructor(
    readonly result: TestTaskResult,
    public failExecution = false,
  ) {}

  destroy(): Promise<void> {
    if (this.failDestroy) {
      return Effect.runPromise(
        new TestObjectUnavailable({ message: "The sandbox destroy failed" }),
      );
    }
    this.destroyed = true;
    return Promise.resolve();
  }

  exec(command: string): Promise<{ readonly success: boolean }> {
    this.commands.push(command);
    return this.failExecution
      ? Effect.runPromise(
          new TestObjectUnavailable({
            message: "The sandbox response is ambiguous",
          }),
        )
      : Promise.resolve({ success: true });
  }

  readFile(): Promise<{ readonly content: string }> {
    return Promise.resolve({ content: JSON.stringify(this.result) });
  }

  writeFile(path: string): Promise<void> {
    this.writtenPaths.push(path);
    return this.failWrite
      ? Effect.runPromise(new TestObjectUnavailable({ message: "The sandbox write failed" }))
      : Promise.resolve();
  }
}

type TestTaskResult =
  | {
      readonly normalizedText: string;
      readonly ok: true;
      readonly parser: string;
    }
  | { readonly ok: true; readonly resultText: string };

const catalogWithRetainedLimits = (limits: {
  readonly adventurer: bigint;
  readonly adventurerUploadBytes?: bigint;
  readonly free: bigint;
  readonly freeUploadBytes?: bigint;
}): PlanPolicyCatalog => {
  const [policy, ...historicalPolicies] = retainedCatalog.policies;
  return {
    ...retainedCatalog,
    policies: [
      {
        ...policy,
        plans: {
          adventurer: {
            ...policy.plans.adventurer,
            liveLimits: {
              ...policy.plans.adventurer.liveLimits,
              retainedFileBytes: limits.adventurer,
            },
            operationLimits: {
              ...policy.plans.adventurer.operationLimits,
              uploadBytes:
                limits.adventurerUploadBytes ?? policy.plans.adventurer.operationLimits.uploadBytes,
            },
          },
          free: {
            ...policy.plans.free,
            liveLimits: {
              ...policy.plans.free.liveLimits,
              retainedFileBytes: limits.free,
            },
            operationLimits: {
              ...policy.plans.free.operationLimits,
              uploadBytes: limits.freeUploadBytes ?? policy.plans.free.operationLimits.uploadBytes,
            },
          },
        },
      },
      ...historicalPolicies,
    ],
  };
};

const inAgent = <A, E>(
  agent: DurableObjectStub<OsfoAgent>,
  operation: (store: ReturnType<typeof makeFileStore>) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.promise(() =>
    runInDurableObject(agent, async (_instance, state) => {
      const store = makeFileStore(makeAgentDb(state.storage));
      return await Effect.runPromiseExit(operation(store));
    }),
  ).pipe(
    Effect.flatMap(
      Exit.match({
        onFailure: Effect.failCause,
        onSuccess: Effect.succeed,
      }),
    ),
  );

const acceptedInput = (
  changes: Partial<{
    readonly acceptedAt: string;
    readonly byteLength: bigint;
    readonly digest: FileDigest;
    readonly fileId: string;
    readonly fileName: string;
    readonly uploadId: string;
  }> = {},
) => ({
  acceptedAt: DbTimestamp.make(changes.acceptedAt ?? "2026-08-16T12:00:00.000Z"),
  allowancePeriodId: AllowancePeriodId.make("allowance-files"),
  byteLength: changes.byteLength ?? 60n,
  fileId: FileId.make(changes.fileId ?? "file-1"),
  fileName: changes.fileName ?? "notes.txt",
  mediaType: "text/plain" as const,
  objectKey: "agents/agent-files/files/file-1/source",
  retainedByteLimit: 100n,
  sha256: changes.digest ?? digest("a"),
  uploadId: FileUploadId.make(changes.uploadId ?? "upload-1"),
  userId: UserId.make("user-files"),
});

const digest = (hex: string): FileDigest =>
  Schema.decodeSync(FileDigest)(`sha256:${hex.repeat(64)}`);
