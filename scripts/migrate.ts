import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { migrate } from "./migrations";

migrate.pipe(
  Effect.tap(() => Effect.logInfo("Database migrations complete")),
  NodeRuntime.runMain,
);
