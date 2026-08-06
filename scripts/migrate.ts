import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { migrate } from "./migrations";

migrate.pipe(
  Effect.tap((applied) =>
    Effect.logInfo(applied.length === 0 ? "Migrations are current" : "Migrations applied", {
      applied,
    }),
  ),
  NodeRuntime.runMain,
);
