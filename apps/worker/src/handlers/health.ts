import { Api, type HealthResponse } from "@osfo/api";
import { Effect, type ManagedRuntime } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { type ExecutionUnit, probeExecutionUnit } from "../layers";

/** Implement the public health contract with the request-scoped Worker runtime. */
export const layer = (runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>) =>
  HttpApiBuilder.group(Api, "health", (handlers) =>
    handlers.handle("get", () =>
      Effect.promise(() => runtime.runPromise(probeExecutionUnit)).pipe(
        Effect.map((probe): HealthResponse => ({
          activationId: probe.activationId,
          executionUnit: "worker",
          identity: "request",
          kind: "RuntimeProbe",
          stage: probe.stage,
        })),
      ),
    ),
  );

export * as HealthHandlers from "./health";
