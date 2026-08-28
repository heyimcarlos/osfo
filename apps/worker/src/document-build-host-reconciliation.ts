import { Effect } from "effect";

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
) =>
  Effect.forEach(
    candidates,
    (candidate) =>
      workflow
        .create(
          candidate.mainInstanceId,
          candidate.timerInstanceId,
          DocumentBuild.WorkflowPayload.make({
            inputDigest: candidate.inputDigest,
            workflowId: candidate.workflowId,
          }),
        )
        .pipe(Effect.result),
    { concurrency: 2, discard: true },
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
