import { Effect } from "effect";

import * as DocumentGeneration from "./composition/document-generation";
import * as Db from "./db";

/** Reconcile durable document provider costs from one scheduled Worker event. */
export const run = (env: { readonly ARTIFACTS: R2Bucket; readonly DB: Hyperdrive }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        Db.database,
        (database) => DocumentGeneration.reconcileCosts(env, database),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scheduled maintenance is an application entry point.
      ).pipe(Effect.provide(Db.layer({ db: env.DB }))),
    ),
  );
