import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import {
  bootstrapDatabaseAccess,
  migrateDatabase,
  readDevelopmentAgentRunEvidence,
} from "@osfo/db";
import { seedReferenceClientAuthority } from "@osfo/db/reference-client";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const Uuid = Schema.String.check(Schema.isUUID());
const DatabaseRole = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9@._-]{0,62}$/u));
const DatabaseName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,62}$/u));

const DatabaseJobConfig = Config.all({
  job: Config.schema(
    Schema.Literals(["bootstrap", "migrate", "reconcile", "seed"]),
    "OSFO_DATABASE_JOB",
  ),
});

const DatabaseUrlConfig = Config.nonEmptyString("OSFO_DATABASE_URL");

const DatabaseBootstrapConfig = Config.all({
  databaseAdminUrl: Config.schema(Schema.Redacted(Schema.URLFromString), "OSFO_DATABASE_ADMIN_URL"),
  migrationRole: Config.schema(DatabaseRole, "OSFO_DATABASE_MIGRATION_ROLE"),
  runtimeRoles: Config.nonEmptyString("OSFO_DATABASE_RUNTIME_ROLES"),
});

const ReferenceSeedConfig = Config.all({
  authenticationToken: Config.nonEmptyString("OSFO_REFERENCE_AUTHENTICATION_TOKEN"),
  threadId: Config.schema(Uuid, "OSFO_REFERENCE_THREAD_ID"),
});

const ReconciliationConfig = Config.all({
  agentRunId: Config.schema(Uuid, "OSFO_RECONCILIATION_AGENT_RUN_ID"),
  requirePass: Config.boolean("OSFO_RECONCILIATION_REQUIRE_PASS").pipe(Config.withDefault(true)),
});

class DevelopmentReconciliationFailed extends Data.TaggedError("DevelopmentReconciliationFailed")<{
  readonly agentRunId: string;
}> {}

const program = Effect.gen(function* () {
  const config = yield* DatabaseJobConfig;
  if (config.job === "bootstrap") {
    const bootstrap = yield* DatabaseBootstrapConfig;
    const runtimeRoles = yield* Schema.decodeUnknownEffect(
      Schema.Array(DatabaseRole).check(Schema.isMinLength(1)),
    )(bootstrap.runtimeRoles.split(","));
    const databaseName = yield* Schema.decodeUnknownEffect(DatabaseName)(
      Redacted.value(bootstrap.databaseAdminUrl).pathname.slice(1),
    );
    yield* bootstrapDatabaseAccess({
      databaseAdminUrl: bootstrap.databaseAdminUrl,
      databaseName,
      migrationRole: bootstrap.migrationRole,
      runtimeRoles,
    });
    return yield* Effect.logInfo("PASS: database IAM privileges bootstrapped");
  }

  const databaseUrl = yield* DatabaseUrlConfig;
  if (config.job === "migrate") {
    yield* migrateDatabase({
      applicationName: "osfo-development-migration",
      databaseUrl,
    });
    return yield* Effect.logInfo("PASS: database migrations completed");
  }

  if (config.job === "reconcile") {
    const { agentRunId, requirePass } = yield* ReconciliationConfig;
    const evidence = yield* readDevelopmentAgentRunEvidence({ agentRunId, databaseUrl });
    const encodedEvidence = Buffer.from(JSON.stringify(evidence), "utf8").toString("base64");
    yield* Effect.logInfo(`OSFO_RECONCILIATION_EVIDENCE:${encodedEvidence}`);
    if (evidence.verdict === "FAIL") {
      if (requirePass) return yield* new DevelopmentReconciliationFailed({ agentRunId });
      return yield* Effect.logInfo("STATE: AgentRun identity graph is not terminal");
    }
    return yield* Effect.logInfo("PASS: one authoritative AgentRun identity graph reconciled");
  }

  const { authenticationToken, threadId } = yield* ReferenceSeedConfig;
  yield* seedReferenceClientAuthority({
    authenticationToken,
    databaseUrl,
    threadId,
  });
  return yield* Effect.logInfo("PASS: reference authority seed completed", { threadId });
});

NodeRuntime.runMain(program);
