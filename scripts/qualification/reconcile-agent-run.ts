import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { readDevelopmentAgentRunEvidence } from "@osfo/db";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Uuid = Schema.String.check(Schema.isUUID());
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

class QualificationRequiresApprovedProxy extends Data.TaggedError(
  "QualificationRequiresApprovedProxy",
)<{ readonly hostname: string }> {}

class DeploymentReconciliationFailed extends Data.TaggedError("DeploymentReconciliationFailed")<{
  readonly agentRunId: string;
}> {}

const ReconciliationConfig = Config.all({
  agentRunId: Config.schema(Uuid, "OSFO_RECONCILIATION_AGENT_RUN_ID"),
  databaseUrl: Config.schema(Schema.URLFromString, "OSFO_DATABASE_URL"),
  requirePass: Config.boolean("OSFO_RECONCILIATION_REQUIRE_PASS").pipe(Config.withDefault(true)),
});

Effect.gen(function* () {
  const config = yield* ReconciliationConfig;
  if (!loopbackHosts.has(config.databaseUrl.hostname)) {
    return yield* new QualificationRequiresApprovedProxy({
      hostname: config.databaseUrl.hostname,
    });
  }
  const evidence = yield* readDevelopmentAgentRunEvidence({
    agentRunId: config.agentRunId,
    databaseUrl: config.databaseUrl.toString(),
  });
  const encodedEvidence = Buffer.from(JSON.stringify(evidence), "utf8").toString("base64");
  yield* Effect.logInfo(`OSFO_RECONCILIATION_EVIDENCE:${encodedEvidence}`);
  if (evidence.verdict === "FAIL" && config.requirePass) {
    return yield* new DeploymentReconciliationFailed({ agentRunId: config.agentRunId });
  }
  return evidence;
}).pipe(
  Effect.tap((evidence) =>
    evidence.verdict === "PASS"
      ? Effect.logInfo("PASS: one authoritative AgentRun identity graph reconciled")
      : Effect.logInfo("STATE: AgentRun identity graph is not terminal"),
  ),
  NodeRuntime.runMain,
);
