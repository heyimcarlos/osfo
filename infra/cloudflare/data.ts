import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import { Effect } from "effect";

import type { OsfoStage } from "@osfo/worker/env";
import { verifyPostgresMigrationDigests } from "./migration-digests";

/** Define the stage-local data resource group. */
export const dataResources = (stage: OsfoStage) =>
  Effect.gen(function* () {
    yield* verifyPostgresMigrationDigests();
    const db = yield* Neon.Project("Db", {
      pgVersion: 17,
      migrationsDir: "./packages/db/src/migrations",
      migrationsTable: "migrations",
    });
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("Db", {
      caching: { disabled: true },
      origin: db.origin,
    });

    return { db, hyperdrive, stage };
  });
