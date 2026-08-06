import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";

Effect.logInfo("AgentRun worker process role is ready").pipe(NodeRuntime.runMain);
