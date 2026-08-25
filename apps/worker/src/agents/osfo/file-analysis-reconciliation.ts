import { Effect } from "effect";

import type { FileAnalysisId, FileId } from "../../domain/file";

export interface RetainedFileAnalysisFacts {
  readonly analysisId: FileAnalysisId;
  readonly fileId: FileId;
  readonly prompt: string;
}

/** Build the Agent-owned workflow that restores all reconciliation facts from durable state. */
export const make = <Context, Output, AuthorizationError, FindError, AnalyzeError>(dependencies: {
  readonly analyze: (input: {
    readonly actionId: string;
    readonly analysisId: FileAnalysisId;
    readonly context: Context;
    readonly fileId: FileId;
    readonly prompt: string;
  }) => Effect.Effect<Output, AnalyzeError>;
  readonly authorize: () => Effect.Effect<Context, AuthorizationError>;
  readonly find: (
    analysisId: FileAnalysisId,
  ) => Effect.Effect<RetainedFileAnalysisFacts | null, FindError>;
  readonly notFound: (analysisId: FileAnalysisId) => AnalyzeError;
}) =>
  Effect.fn("OsfoAgent.reconcileFileAnalysis")(
    (input: { readonly actionId: string; readonly analysisId: FileAnalysisId }) =>
      dependencies.authorize().pipe(
        Effect.flatMap((context) =>
          dependencies.find(input.analysisId).pipe(
            Effect.flatMap((analysis) =>
              analysis === null
                ? Effect.fail(dependencies.notFound(input.analysisId))
                : dependencies.analyze({
                    actionId: input.actionId,
                    analysisId: input.analysisId,
                    context,
                    fileId: analysis.fileId,
                    prompt: analysis.prompt,
                  }),
            ),
          ),
        ),
      ),
  );

export * as FileAnalysisReconciliation from "./file-analysis-reconciliation";
