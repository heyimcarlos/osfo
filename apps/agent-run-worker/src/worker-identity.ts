import { randomUUID } from "node:crypto";
import { Config } from "effect";

export const makeAgentRunWorkerIdConfig = (
  fallbackId = `agent-run-worker-${randomUUID()}`,
): Config.Config<string> =>
  Config.nonEmptyString("OSFO_AGENT_RUN_WORKER_ID").pipe(
    Config.orElse(() => Config.nonEmptyString("HOSTNAME").pipe(Config.withDefault(fallbackId))),
  );
