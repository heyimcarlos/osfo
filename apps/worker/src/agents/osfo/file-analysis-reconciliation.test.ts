/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the isolated Effect entry point. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { FileAnalysisId, FileId } from "../../domain/file";
import { FileAnalysisReconciliation } from "./file-analysis-reconciliation";

it.effect("reconciles through retained Agent facts and ignores model replacement fields", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const reconcile = FileAnalysisReconciliation.make({
      analyze: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { _tag: "Reconciled" as const };
        }),
      authorize: () => Effect.succeed({ userId: "authorized-user" }),
      find: (analysisId) =>
        Effect.succeed({
          analysisId,
          fileId: FileId.make("retained-file"),
          prompt: "Retained analysis prompt",
        }),
      notFound: () => ({ _tag: "MissingAnalysis" as const }),
    });
    const hostileInput = {
      actionId: "reconcile-call",
      analysisId: FileAnalysisId.make("retained-analysis"),
      fileId: FileId.make("model-replacement-file"),
      prompt: "Model replacement prompt",
    };

    yield* reconcile(hostileInput);

    expect(calls).toEqual([
      {
        actionId: "reconcile-call",
        analysisId: "retained-analysis",
        context: { userId: "authorized-user" },
        fileId: "retained-file",
        prompt: "Retained analysis prompt",
      },
    ]);
  }),
);
