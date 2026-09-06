import { IncidentControlsPostgres } from "./integrations/postgres/incident-controls";
import { Effect, Result } from "effect";

import { DocumentBuildComposition } from "./composition/document-build";
import { Db } from "./db";
import { DocumentBuildPostgres } from "./integrations/postgres/document-build";
import { DocumentBuild } from "./services/document-build";

const maximumRepairsPerRun = 20;

export interface RecoveryCandidate {
  readonly inputDigest: DocumentBuild.InputDigest;
  readonly mainInstanceId: DocumentBuild.CloudflareInstanceId;
  readonly timerInstanceId: DocumentBuild.CloudflareInstanceId;
  readonly workflowId: DocumentBuild.WorkflowId;
}

/** Reconcile stable timer/main owners for one already bounded database batch. */
export const repair = (
  candidates: ReadonlyArray<RecoveryCandidate>,
  workflow: DocumentBuild.PortInterface["workflow"],
  disposition: (
    candidate: RecoveryCandidate,
  ) => Effect.Effect<"Keep" | "Terminate", DocumentBuild.Unavailable>,
) =>
  Effect.forEach(
    candidates,
    (candidate) =>
      Effect.gen(function* () {
        const created = yield* workflow
          .create(
            candidate.mainInstanceId,
            candidate.timerInstanceId,
            DocumentBuild.WorkflowPayload.make({
              inputDigest: candidate.inputDigest,
              workflowId: candidate.workflowId,
            }),
          )
          .pipe(Effect.result);
        const eligibility = yield* disposition(candidate).pipe(Effect.result);
        if (Result.isFailure(eligibility)) return false;
        if (eligibility.success === "Terminate") {
          return yield* workflow
            .terminate(candidate.mainInstanceId, candidate.timerInstanceId)
            .pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
        }
        return Result.isSuccess(created);
      }),
    { concurrency: 2 },
  ).pipe(
    Effect.flatMap((results) => {
      const failed = results.filter((result) => !result).length;
      return failed === 0
        ? Effect.void
        : Effect.fail(
            new DocumentBuild.Unavailable({
              cause: failed,
              message: `Document Build host repair failed for ${failed} candidate(s)`,
              operation: "hostRecovery.repair",
            }),
          );
    }),
  );

/** Hourly production owner for missing or exhausted Document Build Workflow instances. */
export const run = (env: DocumentBuildComposition.Bindings) =>
  Effect.runPromise(
    Effect.scoped(
      Db.database.pipe(
        Effect.flatMap((database) =>
          DocumentBuildPostgres.hostRecoveryBatch(database, maximumRepairsPerRun).pipe(
            Effect.flatMap((candidates) =>
              repair(
                candidates,
                DocumentBuildComposition.makeWorkflowPort(
                  env.DOCUMENT_BUILD_WORKFLOW,
                  env.DOCUMENT_BUILD_TIMER_WORKFLOW,
                  IncidentControlsPostgres.makeFromDatabase(database).check("newCostlyWork"),
                ),
                (candidate) =>
                  DocumentBuildPostgres.hostRecoveryDisposition(
                    database,
                    candidate.workflowId,
                    candidate.inputDigest,
                  ),
              ),
            ),
          ),
        ),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scheduled maintenance is an application entry point.
        Effect.provide(Db.layer({ db: env.DB })),
      ),
    ),
  );

export * as DocumentBuildHostReconciliation from "./document-build-host-reconciliation";
