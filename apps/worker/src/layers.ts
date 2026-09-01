import { Context, Effect, Layer, ManagedRuntime, Random, Schema } from "effect";
import { BrowserCrypto } from "@effect/platform-browser";

import { Db } from "./db";
import { OsfoStage, type SupermemoryConfig } from "./config";
import { SupermemoryMemoryProvider } from "./integrations/supermemory/memory-provider";
import { Capabilities } from "./services/capabilities";

/** Schema for the observable identity of one execution-unit runtime. */
export const RuntimeProbe = Schema.Struct({
  kind: Schema.Literal("RuntimeProbe"),
  activationId: Schema.String,
  executionUnit: Schema.Literal("worker"),
  identity: Schema.Literal("request"),
  stage: OsfoStage,
});

/** Observable technical identity for one execution-unit runtime. */
export type RuntimeProbe = typeof RuntimeProbe.Type;

/** Safe environment failure returned by a Cloudflare host boundary. */
export class InvalidOsfoEnvironment extends Schema.TaggedError<InvalidOsfoEnvironment>()(
  "InvalidOsfoEnvironment",
  {
    binding: Schema.Literal("OSFO_STAGE"),
    message: Schema.String,
  },
) {}

/** Safe result for an invalid Osfo stage binding. */
export const invalidOsfoEnvironment = new InvalidOsfoEnvironment({
  binding: "OSFO_STAGE",
  message: "OSFO_STAGE must name a supported deployment stage",
});

interface ExecutionUnitService {
  readonly probe: Effect.Effect<RuntimeProbe>;
}

/** Lifecycle context owned by exactly one Cloudflare execution unit. */
export class ExecutionUnit extends Context.Service<ExecutionUnit, ExecutionUnitService>()(
  "@osfo/worker/ExecutionUnit",
) {}

/** Read the current execution-unit identity through the Effect service seam. */
export const probeExecutionUnit: Effect.Effect<RuntimeProbe, never, ExecutionUnit> = Effect.flatMap(
  ExecutionUnit,
  (service) => service.probe,
);

/** Create a request-scoped Worker runtime. */
export const makeWorkerRuntime = (stage: OsfoStage) =>
  ManagedRuntime.make(makeExecutionUnitLayer(stage));

/** Create an activation-scoped Osfo Agent runtime. */
export const makeOsfoAgentRuntime = (database: Db.Options, supermemory: SupermemoryConfig) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Db.layer(database),
      BrowserCrypto.layer,
      Capabilities.layer,
      SupermemoryMemoryProvider.layerFromConfig(supermemory),
    ),
  );

/** Create an execution-scoped Workflow runtime. */
export const makeWorkflowRuntime = () => ManagedRuntime.make(Layer.empty);

const makeExecutionUnitLayer = (stage: OsfoStage) =>
  Layer.effect(
    ExecutionUnit,
    Random.next.pipe(
      Effect.map((random) => {
        const probe: RuntimeProbe = {
          kind: "RuntimeProbe",
          activationId: random.toString(16),
          executionUnit: "worker",
          identity: "request",
          stage,
        };

        return { probe: Effect.succeed(probe) };
      }),
    ),
  );
