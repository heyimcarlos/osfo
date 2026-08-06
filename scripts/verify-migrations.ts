import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { verifyDatabaseMigrations } from "@osfo/db";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const verifyMigrationBaseline = Config.nonEmptyString("OSFO_DATABASE_URL").pipe(
  Effect.flatMap((databaseUrl) =>
    verifyDatabaseMigrations({
      applicationName: "osfo-migration-verification",
      databaseUrl,
    }),
  ),
);

verifyMigrationBaseline.pipe(
  Effect.tap((baseline) => Effect.logInfo("Migration baseline verified", baseline)),
  NodeRuntime.runMain,
);
