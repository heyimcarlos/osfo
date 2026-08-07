import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { checkDatabaseMigrationReadiness } from "@osfo/db";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

class DatabaseReadinessRequiresApprovedProxy extends Data.TaggedError(
  "DatabaseReadinessRequiresApprovedProxy",
)<{ readonly hostname: string }> {}

Effect.gen(function* () {
  const databaseUrl = yield* Config.schema(Schema.URLFromString, "OSFO_DATABASE_URL");
  if (!loopbackHosts.has(databaseUrl.hostname)) {
    return yield* new DatabaseReadinessRequiresApprovedProxy({ hostname: databaseUrl.hostname });
  }
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
