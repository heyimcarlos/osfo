import { Api, type HealthResponse } from "@osfo/api";
import { Effect, Random } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import type { OsfoStage } from "../config";

/** Implement the public health contract in the HTTP application's existing scope. */
export const layer = (stage: OsfoStage) =>
  HttpApiBuilder.group(Api, "health", (handlers) =>
    Random.next.pipe(
      Effect.map((random) =>
        handlers.handle("get", () =>
          Effect.succeed({
            activationId: random.toString(16),
            executionUnit: "worker",
            identity: "request",
            kind: "RuntimeProbe",
            stage,
          } satisfies HealthResponse),
        ),
      ),
    ),
  );

export * as HealthHandlers from "./health";
