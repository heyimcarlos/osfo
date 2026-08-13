import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

import type { OsfoStage } from "@osfo/worker/env";
import { verifyD1MigrationDigests } from "./migration-digests";

/** Define the stage-local data resource group. */
export const dataResources = (stage: OsfoStage) =>
  Effect.gen(function* () {
    yield* verifyD1MigrationDigests();
    const db = yield* Cloudflare.D1.Database("Db", {
      migrationsDir: "./apps/worker/src/db/migrations",
      migrationsTable: "migrations",
    });

    return { db, stage };
  });
