import { Effect, Schema } from "effect";

import { OSFO_DIRECTORY_NAME } from "./agents/osfo/identity";
import { Db } from "./db";
import { ScheduledEmailPostgres } from "./integrations/postgres/scheduled-email";
import { ScheduledEmail } from "./services/scheduled-email";

const maximumRepairsPerRun = 20;
const ReconciliationResult = Schema.Struct({ state: ScheduledEmail.State });

export interface ReconciliationDirectory {
  readonly executeScheduledEmail: (payload: ScheduledEmail.WorkflowPayload) => Promise<unknown>;
  readonly recoverScheduledEmail: (payload: ScheduledEmail.WorkflowPayload) => Promise<unknown>;
}

/** Route due work through the ordinary fence and already-claimed work through inspect-only recovery. */
export const repair = (
  candidates: ReadonlyArray<ScheduledEmail.ReconciliationCandidate>,
  directory: ReconciliationDirectory,
) =>
  Effect.forEach(
    candidates,
    (candidate) =>
      Effect.tryPromise({
        try: async (): Promise<unknown> => {
          const payload = {
            agentId: candidate.agentId,
            dueAt: candidate.dueAt,
            inputDigest: candidate.inputDigest,
            workflowId: candidate.workflowId,
          };
          return candidate.kind === "claimed"
            ? await directory.recoverScheduledEmail(payload)
            : await directory.executeScheduledEmail(payload);
        },
        catch: (cause) => unavailable(candidate.workflowId, cause),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ReconciliationResult)),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    { concurrency: 2 },
  ).pipe(
    Effect.flatMap((outcomes) => {
      const failed = outcomes.filter((outcome) => !outcome).length;
      return failed === 0 ? Effect.void : Effect.fail(unavailable("batch", failed));
    }),
  );

/** Minute fallback for due or provider-claimed emails whose original host completed or vanished. */
export const run = (env: Pick<Env, "DB" | "OSFO_DIRECTORY">) =>
  Effect.runPromise(
    Effect.scoped(
      Db.database.pipe(
        Effect.flatMap((database) =>
          Effect.gen(function* () {
            const now = yield* Effect.sync(() => new Date());
            const candidates = yield* ScheduledEmailPostgres.reconciliationBatch(
              database,
              now,
              maximumRepairsPerRun,
            );
            const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
            yield* repair(candidates, directory);
          }),
        ),
        Effect.provide(Db.layer({ db: env.DB })),
      ),
    ),
  );

const unavailable = (operation: string, cause: unknown) =>
  new ScheduledEmail.Unavailable({
    cause,
    message: "Scheduled Email reconciliation is unavailable",
    operation,
  });

export * as ScheduledEmailReconciliation from "./scheduled-email-reconciliation";
