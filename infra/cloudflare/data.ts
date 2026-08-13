import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

import type { OsfoStage } from "@osfo/worker/env";
import { verifyD1MigrationDigests } from "./migration-digests";

/** Define the stage-local data resource group. */
export const dataResources = (stage: OsfoStage) =>
  Effect.gen(function* () {
    yield* verifyD1MigrationDigests();
    const directory = yield* Cloudflare.D1.Database("Directory", {
      migrationsDir: "./apps/worker/drizzle/directory",
      migrationsTable: "directory_migrations",
    });
    const erasureReceipts = yield* Cloudflare.D1.Database("ErasureReceipts", {
      migrationsDir: "./apps/worker/drizzle/erasure-receipts",
      migrationsTable: "erasure_receipt_migrations",
    });

    return { directory, erasureReceipts, stage };
  });
