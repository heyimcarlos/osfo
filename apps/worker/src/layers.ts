import { Context, Effect, Layer, ManagedRuntime, Random, Schema } from "effect";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";

import * as Db from "./db";
import { OsfoStage, type OsfoStage as OsfoStageType } from "./env";

/** Schema for a Cloudflare execution unit that owns an Effect runtime. */
export const ExecutionUnitKind = Schema.Literals([
  "worker",
  "osfo-agent",
  "registration-dialogue",
  "workflow",
]);

/** The Cloudflare execution unit that owns an Effect runtime. */
export type ExecutionUnitKind = typeof ExecutionUnitKind.Type;

/** Schema for the observable identity of one execution-unit runtime. */
export const RuntimeProbe = Schema.Struct({
  kind: Schema.Literal("RuntimeProbe"),
  activationId: Schema.String,
  executionUnit: ExecutionUnitKind,
  identity: Schema.String,
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

/** Schema for results returned by technical runtime probes. */
export const RuntimeProbeResult = Schema.Union([RuntimeProbe, InvalidOsfoEnvironment]);

/** Result returned by technical runtime probes. */
export type RuntimeProbeResult = typeof RuntimeProbeResult.Type;

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
export const makeWorkerRuntime = (stage: OsfoStageType) => makeRuntime("worker", "request", stage);

/** Create an activation-scoped Osfo Agent runtime. */
export const makeOsfoAgentRuntime = (
  identity: string,
  stage: OsfoStageType,
  database: Db.Options,
) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      makeExecutionUnitLayer("osfo-agent", identity, stage),
      Db.layer(database),
      BrowserCrypto.layer,
    ),
  );

/** Create an activation-scoped registration runtime. */
export const makeRegistrationDialogueRuntime = (identity: string, stage: OsfoStageType) =>
  makeRuntime("registration-dialogue", identity, stage);

/** Create an execution-scoped Workflow runtime. */
export const makeWorkflowRuntime = (identity: string, stage: OsfoStageType) =>
  makeRuntime("workflow", identity, stage);

const makeRuntime = (executionUnit: ExecutionUnitKind, identity: string, stage: OsfoStageType) =>
  ManagedRuntime.make(makeExecutionUnitLayer(executionUnit, identity, stage));

const makeExecutionUnitLayer = (
  executionUnit: ExecutionUnitKind,
  identity: string,
  stage: OsfoStageType,
) =>
  Layer.effect(
    ExecutionUnit,
    Random.next.pipe(
      Effect.map((random) => {
        const probe: RuntimeProbe = {
          kind: "RuntimeProbe",
          activationId: random.toString(16),
          executionUnit,
          identity,
          stage,
        };

        return { probe: Effect.succeed(probe) };
      }),
    ),
  );
