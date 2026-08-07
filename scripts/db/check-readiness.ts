import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { checkDatabaseMigrationReadiness } from "@osfo/db";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { requireApprovedDatabaseProxy } from "./approved-database-proxy";

Effect.gen(function* () {
  const databaseUrl = yield* Config.schema(Schema.URLFromString, "OSFO_DATABASE_URL");
  yield* requireApprovedDatabaseProxy(databaseUrl, "migration readiness check");
  return yield* checkDatabaseMigrationReadiness(databaseUrl.toString());
}).pipe(
  Effect.tap(({ latestMigrationName, migrationCount }) =>
    Effect.logInfo("PASS: database migration version is ready", {
      latestMigrationName,
      migrationCount,
    }),
  ),
  NodeRuntime.runMain,
);
