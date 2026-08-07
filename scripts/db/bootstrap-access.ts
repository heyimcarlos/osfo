import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { bootstrapDatabaseAccess } from "@osfo/db";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const DatabaseRole = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9@._-]{0,62}$/u));
const DatabaseName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,62}$/u));
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

class DatabaseAccessBootstrapRequiresApprovedProxy extends Data.TaggedError(
  "DatabaseAccessBootstrapRequiresApprovedProxy",
)<{ readonly hostname: string }> {}

const DatabaseBootstrapConfig = Config.all({
  databaseAdminUrl: Config.schema(Schema.Redacted(Schema.URLFromString), "OSFO_DATABASE_ADMIN_URL"),
  runtimeRoles: Config.nonEmptyString("OSFO_DATABASE_RUNTIME_ROLES"),
});

Effect.gen(function* () {
  const config = yield* DatabaseBootstrapConfig;
  const databaseAdminUrl = Redacted.value(config.databaseAdminUrl);
  if (!loopbackHosts.has(databaseAdminUrl.hostname)) {
    return yield* new DatabaseAccessBootstrapRequiresApprovedProxy({
      hostname: databaseAdminUrl.hostname,
    });
  }
  const runtimeRoles = yield* Schema.decodeUnknownEffect(
    Schema.Array(DatabaseRole).check(Schema.isMinLength(1)),
  )(config.runtimeRoles.split(","));
  const databaseName = yield* Schema.decodeUnknownEffect(DatabaseName)(
    databaseAdminUrl.pathname.slice(1),
  );

  yield* bootstrapDatabaseAccess({
    databaseAdminUrl: config.databaseAdminUrl,
    databaseName,
    runtimeRoles,
  });
}).pipe(
  Effect.tap(() => Effect.logInfo("PASS: one-time PostgreSQL IAM grants bootstrapped")),
  NodeRuntime.runMain,
);
