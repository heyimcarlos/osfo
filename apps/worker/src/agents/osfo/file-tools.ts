import { action, type Action } from "@cloudflare/think";
import { tool, type ToolSet } from "ai";
import { Effect, Predicate, Schema } from "effect";

import {
  FileAnalysisId,
  type FileAnalysisRecord,
  FileId,
  type FileName,
  type FileRecord,
} from "../../domain/file";
import type { FileMediaType } from "../../domain/file-content";
import type {
  ApprovalRequired,
  AuthorizationDenialReason,
  Denied,
} from "../../services/authorization";
import { effectToolSchema } from "./effect-tool-schema";

const boundedAnalysisPrompt = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64_000),
);

/** Model input for one bounded read of an owned retained file. */
export const ReadFileToolInput = Schema.Struct({ fileId: FileId });

/** Model input for starting or reconciling one bounded analysis of an owned retained file. */
export const AnalyzeFileToolInput = Schema.Union([
  Schema.Struct({
    fileId: FileId,
    mode: Schema.tag("start"),
    prompt: boundedAnalysisPrompt,
  }),
  Schema.Struct({
    analysisId: FileAnalysisId,
    mode: Schema.tag("reconcile"),
  }),
]);

interface ReadFileOperationInput {
  readonly actionId: string;
  readonly fileId: FileId;
}

interface StartFileAnalysisOperationInput {
  readonly actionId: string;
  readonly analysisId: FileAnalysisId;
  readonly fileId: FileId;
  readonly prompt: string;
}

interface ReconcileFileAnalysisOperationInput {
  readonly actionId: string;
  readonly analysisId: FileAnalysisId;
}

type ReadFileOperationResult =
  | ApprovalRequired
  | Denied
  | {
      readonly _tag: "FileRead";
      readonly bytes: Uint8Array;
      readonly file: FileRecord;
    };

type AnalyzeFileOperationResult = ApprovalRequired | Denied | FileAnalysisRecord;

/** Deep file Effects adapted once at the model SDK boundary owned by this module. */
export interface FileToolDependencies<ReadError, AnalyzeError> {
  readonly reconcileAnalysis: (
    input: ReconcileFileAnalysisOperationInput,
  ) => Effect.Effect<AnalyzeFileOperationResult, AnalyzeError>;
  readonly startAnalysis: (
    input: StartFileAnalysisOperationInput,
  ) => Effect.Effect<AnalyzeFileOperationResult, AnalyzeError>;
  readonly read: (
    input: ReadFileOperationInput,
  ) => Effect.Effect<ReadFileOperationResult, ReadError>;
}

export interface FileToolDenied {
  readonly _tag: "FileToolDenied";
  readonly message: string;
  readonly reason: AuthorizationDenialReason;
}

export interface FileToolUnavailable {
  readonly _tag: "FileToolUnavailable";
  readonly message: string;
}

export interface FileContentRead {
  readonly _tag: "FileContentRead";
  readonly content: string;
  readonly fileId: FileId;
  readonly fileName: FileName;
  readonly mediaType: FileMediaType;
}

export interface FileAnalysisCompleted {
  readonly _tag: "FileAnalysisCompleted";
  readonly analysisId: FileAnalysisId;
  readonly fileId: FileId;
  readonly resultText: string;
}

export interface FileAnalysisPending {
  readonly _tag: "FileAnalysisPending";
  readonly analysisId: FileAnalysisId;
  readonly fileId: FileId;
  readonly message: string;
}

export type ReadFileToolResult = FileContentRead | FileToolDenied | FileToolUnavailable;

export type AnalyzeFileToolResult =
  | FileAnalysisCompleted
  | FileAnalysisPending
  | FileToolDenied
  | FileToolUnavailable;

const unavailable = {
  _tag: "FileToolUnavailable",
  message: "The retained file operation is unavailable",
} as const;

const analyzeFileInputSchema = effectToolSchema(AnalyzeFileToolInput);

/** Closed model registry for retained-file capabilities. */
export interface FileToolRegistry {
  readonly actions: {
    readonly analyzeFile: Action<typeof analyzeFileInputSchema, AnalyzeFileToolResult>;
  };
  readonly tools: ToolSet;
}

/** Register read-only file access separately from effectful, idempotent file analysis. */
export const makeFileTools = <ReadError, AnalyzeError>(
  dependencies: FileToolDependencies<ReadError, AnalyzeError>,
): FileToolRegistry => ({
  actions: {
    analyzeFile: action({
      description:
        "Analyze one owned normalized file in bounded disposable compute. Start with mode=start, fileId, and prompt. Reconcile pending work later with only mode=reconcile and the returned analysisId.",
      execute: (input, context) =>
        Effect.runPromise(
          (input.mode === "start"
            ? dependencies.startAnalysis({
                actionId: context.toolCallId,
                analysisId: FileAnalysisId.make(context.toolCallId),
                fileId: input.fileId,
                prompt: input.prompt,
              })
            : dependencies.reconcileAnalysis({
                actionId: context.toolCallId,
                analysisId: input.analysisId,
              })
          ).pipe(
            Effect.map(projectAnalysisResult),
            Effect.orElseSucceed(() => unavailable),
          ),
        ),
      idempotencyKey: ({ ctx }) => `file-analysis:${ctx.toolCallId}`,
      inputSchema: analyzeFileInputSchema,
      permissions: ["files:analyze"],
      timeoutMs: 60_000,
    }),
  },
  tools: {
    readFile: tool<typeof ReadFileToolInput.Type, ReadFileToolResult, Record<string, never>>({
      description:
        "Read the bounded normalized text of one owned retained file. The file identifier must come from trusted Osfo file metadata.",
      execute: (input, context) =>
        Effect.runPromise(
          dependencies.read({ actionId: context.toolCallId, fileId: input.fileId }).pipe(
            Effect.map(projectReadResult),
            Effect.orElseSucceed(() => unavailable),
          ),
        ),
      inputSchema: effectToolSchema(ReadFileToolInput),
    }),
  } satisfies ToolSet,
});

const projectReadResult = (outcome: ReadFileOperationResult): ReadFileToolResult => {
  if (Predicate.isTagged(outcome, "Denied")) {
    return {
      _tag: "FileToolDenied",
      message: "The retained file is not available to this turn",
      reason: outcome.reason,
    };
  }
  if (!Predicate.isTagged(outcome, "FileRead") || outcome.file.state !== "ready") {
    return unavailable;
  }
  return {
    _tag: "FileContentRead",
    content: outcome.file.normalizedText,
    fileId: outcome.file.fileId,
    fileName: outcome.file.fileName,
    mediaType: outcome.file.mediaType,
  };
};

const projectAnalysisResult = (outcome: AnalyzeFileOperationResult): AnalyzeFileToolResult => {
  if (Predicate.isTagged(outcome, "Denied")) {
    return {
      _tag: "FileToolDenied",
      message: "File analysis is not available to this turn",
      reason: outcome.reason,
    };
  }
  if (Predicate.isTagged(outcome, "ApprovalRequired")) return unavailable;
  if (outcome.state === "completed") {
    return {
      _tag: "FileAnalysisCompleted",
      analysisId: outcome.analysisId,
      fileId: outcome.fileId,
      resultText: outcome.resultText,
    };
  }
  if (outcome.state === "pending" || outcome.state === "ambiguous") {
    return {
      _tag: "FileAnalysisPending",
      analysisId: outcome.analysisId,
      fileId: outcome.fileId,
      message:
        "File analysis has not completed yet; call analyzeFile with mode=reconcile and this analysisId",
    };
  }
  return unavailable;
};
