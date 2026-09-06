import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Effect, Schema } from "effect";

import type { FileMediaType } from "../../domain/file-content";
import { FilePagesEvidence } from "../../domain/file-evidence";
import {
  FileComputeFailed,
  type FileAnalysisComputeResult,
  type FileCompute,
  FileNormalizationProvenance,
  type launchFileComputeLimits,
} from "../../services/files";
import fileTaskSource from "./file-task.txt";

const taskTimeoutMilliseconds = 30_000;

/* oxlint-disable effecttsgo/async-function -- Sandbox SDK methods are Promise-only I/O boundaries. */

const SuccessfulTask = Schema.Struct({
  normalizedText: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  pages: Schema.optional(FilePagesEvidence),
  parser: Schema.optional(Schema.String),
  resultText: Schema.optional(Schema.String),
});

const FailedTask = Schema.Struct({
  message: Schema.String,
  ok: Schema.Literal(false),
  reason: Schema.Literals(["content_limit", "malicious", "parser_failure"]),
});

const TaskResult = Schema.Union([SuccessfulTask, FailedTask]);

type TaskResult = typeof TaskResult.Type;

interface FileTaskSandbox {
  readonly destroy: () => Promise<void>;
  readonly exec: (
    command: string,
    options: { readonly timeout: number },
  ) => Promise<{ readonly success: boolean }>;
  readonly readFile: (
    path: string,
    options: { readonly encoding: "utf-8" },
  ) => Promise<{ readonly content: string }>;
  readonly writeFile: (
    path: string,
    content: ReadableStream<Uint8Array> | string,
  ) => Promise<void | { readonly success: boolean }>;
}

interface AnalysisTaskInput {
  readonly mediaType: FileMediaType;
  readonly normalizedText: string;
  readonly operation: "analyze";
  readonly prompt: string;
}

interface NormalizationTaskInput {
  readonly limits: typeof launchFileComputeLimits;
  readonly mediaType: FileMediaType;
  readonly operation: "normalize";
}

/** Create disposable, bounded Python file compute from the Cloudflare Sandbox binding. */
export const makeCloudflareFileCompute = (binding: DurableObjectNamespace<Sandbox>): FileCompute =>
  makeFileCompute((taskId) =>
    getSandbox(binding, sandboxIdFor(taskId), { enableDefaultSession: false, sleepAfter: "1m" }),
  );

/** Bound one durable logical File operation to Cloudflare's Sandbox identifier contract. */
export const sandboxIdFor = (taskScope: string) =>
  `file-${bytesToHex(sha256(new TextEncoder().encode(taskScope))).slice(0, 58)}`;

/** Create the narrow file task adapter over one isolated-sandbox resolver. */
export const makeFileCompute = (sandboxFor: (taskId: string) => FileTaskSandbox): FileCompute => ({
  analyze: (input) =>
    runAnalysisTask(sandboxFor(input.taskScope), {
      mediaType: input.mediaType,
      normalizedText: input.normalizedText,
      operation: "analyze",
      prompt: input.prompt,
    }),
  normalize: (input) =>
    Effect.acquireUseRelease(
      Effect.sync(() => sandboxFor(input.taskScope)),
      (sandbox) =>
        Effect.gen(function* () {
          yield* writeTaskFiles(
            sandbox,
            {
              limits: input.limits,
              mediaType: input.mediaType,
              operation: "normalize",
            },
            input.bytes,
          );
          const result = yield* executeTask(sandbox).pipe(
            Effect.catchTag("FileComputeFailed", (failure) =>
              failure.kind === "task_rejected"
                ? failure
                : readResult(sandbox).pipe(
                    Effect.mapError(
                      () =>
                        new FileComputeFailed({
                          basis: "conservative",
                          kind: "dependency_unavailable",
                          message: "Sandbox normalization outcome could not be reconciled",
                          reason: "parser_failure",
                          vendorUsdMicros: input.conservativeVendorUsdMicros,
                        }),
                    ),
                  ),
            ),
          );
          if (!result.ok) return yield* taskFailure(result);
          if (result.normalizedText === undefined || result.parser === undefined) {
            return yield* invalidTaskResult("Normalization output is incomplete");
          }
          if (
            (input.mediaType === "application/pdf" || input.mediaType.startsWith("image/")) &&
            result.pages === undefined
          ) {
            return yield* invalidTaskResult("Document page evidence is missing");
          }
          if (
            new TextEncoder().encode(result.normalizedText).byteLength >
              input.limits.maximumNormalizedTextBytes ||
            (result.pages ?? []).reduce(
              (total, page) => total + new TextEncoder().encode(page.text).byteLength,
              0,
            ) > input.limits.maximumNormalizedTextBytes
          ) {
            return yield* new FileComputeFailed({
              basis: null,
              kind: "task_rejected",
              message: "Normalized file content exceeds the retained text limit",
              reason: "content_limit",
              vendorUsdMicros: 0n,
            });
          }
          const provenance = yield* Schema.decodeEffect(FileNormalizationProvenance)({
            mediaType: input.mediaType,
            pages: result.pages,
            parser: result.parser,
            sourceSha256: input.sha256,
          }).pipe(Effect.mapError(() => invalidTaskResult("Normalization provenance is invalid")));
          return {
            normalizedText: result.normalizedText,
            provenance,
            // The pinned Osfo-owned container has no separately metered provider operation.
            vendorCost: null,
          };
        }),
      (sandbox) => destroy(sandbox),
    ),
  reconcileAnalysis: (taskScope) => readAnalysisResult(sandboxFor(taskScope)),
  releaseAnalysis: (taskScope) => destroy(sandboxFor(taskScope)),
});

const runAnalysisTask = (
  sandbox: FileTaskSandbox,
  input: AnalysisTaskInput,
): Effect.Effect<FileAnalysisComputeResult, FileComputeFailed> =>
  writeTaskFiles(sandbox, input).pipe(
    Effect.andThen(
      executeTask(sandbox).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.succeed({
              _tag: "AnalysisAmbiguous" as const,
              evidence: "Sandbox analysis outcome requires reconciliation",
              vendorCost: null,
            }),
          onSuccess: toAnalysisResult,
        }),
      ),
    ),
  );

const readAnalysisResult = (
  sandbox: FileTaskSandbox,
): Effect.Effect<FileAnalysisComputeResult, FileComputeFailed> =>
  readResult(sandbox).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.succeed({
          _tag: "AnalysisAmbiguous" as const,
          evidence: "Sandbox analysis result is not available",
          vendorCost: null,
        }),
      onSuccess: toAnalysisResult,
    }),
  );

const toAnalysisResult = (
  result: TaskResult,
): Effect.Effect<FileAnalysisComputeResult, FileComputeFailed> => {
  if (!result.ok) return taskFailure(result);
  if (result.resultText === undefined) return invalidTaskResult("Analysis output is incomplete");
  return Effect.succeed({
    _tag: "AnalysisCompleted",
    resultText: result.resultText,
    // The pinned Osfo-owned container has no separately metered provider operation.
    vendorCost: null,
  });
};

const writeTaskFiles = (
  sandbox: FileTaskSandbox,
  input: AnalysisTaskInput | NormalizationTaskInput,
  bytes?: Uint8Array,
) =>
  dependency("write", async () => {
    await sandbox.writeFile("/workspace/file-task.py", fileTaskSource);
    await sandbox.writeFile("/workspace/input.json", JSON.stringify(input));
    if (bytes !== undefined) await sandbox.writeFile("/workspace/source.bin", bytesStream(bytes));
  });

const executeTask = (sandbox: FileTaskSandbox) =>
  dependency("execute", async () => {
    await sandbox.exec("python3 /workspace/file-task.py", { timeout: taskTimeoutMilliseconds });
  }).pipe(Effect.andThen(readResult(sandbox)));

const readResult = (sandbox: FileTaskSandbox) =>
  dependency("read", () => sandbox.readFile("/workspace/result.json", { encoding: "utf-8" })).pipe(
    Effect.flatMap(({ content }) =>
      Schema.decodeEffect(Schema.fromJsonString(TaskResult))(content).pipe(
        Effect.mapError(() => invalidTaskResult("Sandbox task output is invalid")),
      ),
    ),
  );

const dependency = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new FileComputeFailed({
        basis: null,
        kind: "dependency_unavailable",
        message: `Disposable file compute could not ${operation} its task`,
        reason: "parser_failure",
        vendorUsdMicros: 0n,
      }),
  });

const taskFailure = (result: typeof FailedTask.Type) =>
  new FileComputeFailed({
    basis: null,
    kind: "task_rejected",
    message: result.message,
    reason: result.reason,
    vendorUsdMicros: 0n,
  });

const invalidTaskResult = (message: string) =>
  new FileComputeFailed({
    basis: null,
    kind: "task_rejected",
    message,
    reason: "parser_failure",
    vendorUsdMicros: 0n,
  });

const destroy = (sandbox: FileTaskSandbox) =>
  Effect.tryPromise({
    try: () => sandbox.destroy(),
    catch: () =>
      new FileComputeFailed({
        basis: null,
        kind: "dependency_unavailable",
        message: "Disposable file compute cleanup failed",
        reason: "parser_failure",
        vendorUsdMicros: 0n,
      }),
  });

const bytesStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
