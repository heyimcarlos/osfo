import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { verifyMigrationBaseline } from "./migrations";

verifyMigrationBaseline.pipe(
  Effect.tap((baseline) => Effect.logInfo("Migration baseline verified", baseline)),
  NodeRuntime.runMain,
);
