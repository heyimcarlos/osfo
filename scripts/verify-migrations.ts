import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { migrateDatabase } from "@osfo/db";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const applyMigrations = Config.nonEmptyString("OSFO_DATABASE_URL").pipe(
  Effect.flatMap((databaseUrl) =>
    migrateDatabase({
      applicationName: "osfo-migration-verification",
      databaseUrl,
    }),
  ),
);

applyMigrations.pipe(
  Effect.tap(() => Effect.logInfo("Database migrations applied")),
  NodeRuntime.runMain,
);
