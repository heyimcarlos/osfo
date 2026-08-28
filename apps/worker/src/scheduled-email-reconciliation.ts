import { DateTime, Effect, Schema } from "effect";

import { OSFO_DIRECTORY_NAME } from "./agents/osfo/identity";
import { Db } from "./db";
import { ScheduledEmailPostgres } from "./integrations/postgres/scheduled-email";
import { ScheduledEmail } from "./services/scheduled-email";

/* oxlint-disable effecttsgo/async-function, osfo/no-unknown-returns -- Cloudflare Directory RPC results are untrusted and decoded immediately after the Promise boundary. */

const maximumRepairsPerRun = 20;
const ReconciliationResult = Schema.Struct({ state: ScheduledEmail.State });

export interface ReconciliationDirectory {
  readonly beginScheduledEmail: (payload: ScheduledEmail.WorkflowPayload) => Promise<unknown>;
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
          if (candidate.kind === "due") return await directory.executeScheduledEmail(payload);
          if (candidate.kind === "host") return await directory.beginScheduledEmail(payload);
          return await directory.recoverScheduledEmail(payload);
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
            const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
            const candidates = yield* ScheduledEmailPostgres.reconciliationBatch(
              database,
              now,
              maximumRepairsPerRun,
            );
            const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
            yield* repair(candidates, directory);
          }),
        ),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scheduled maintenance is an application entry point.
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
