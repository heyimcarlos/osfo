import type { ThreadStreamLifecycleStatus } from "@osfo/api";
import { Effect, Option, Schema } from "effect";

const LifecycleStatusSchema = Schema.Struct({
  accepting: Schema.Boolean,
  activeConnections: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  slowConsumerCloses: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const DrainedSchema = Schema.Struct({
  type: Schema.Literal("drained"),
  httpServerListening: Schema.Boolean,
  status: LifecycleStatusSchema,
});

const HttpClosedSchema = Schema.Struct({
  type: Schema.Literal("http_closed"),
});

const SlowConsumerClosedSchema = Schema.Struct({
  type: Schema.Literal("connection_closed"),
  reason: Schema.Literal("slow_consumer"),
  status: LifecycleStatusSchema,
});

export const IngressLifecycleTelemetrySchema = Schema.Union([
  DrainedSchema,
  HttpClosedSchema,
  SlowConsumerClosedSchema,
]);

export type IngressLifecycleTelemetry = typeof IngressLifecycleTelemetrySchema.Type;
export type IngressDrainTelemetry = typeof DrainedSchema.Type;
export type IngressSlowConsumerTelemetry = typeof SlowConsumerClosedSchema.Type;

const LifecycleTelemetryFromJson = Schema.fromJsonString(IngressLifecycleTelemetrySchema);
const telemetryPrefix = "OSFO_INGRESS_LIFECYCLE:";

export const decodeIngressLifecycleTelemetry = (line: string) =>
  line.startsWith(telemetryPrefix)
    ? Schema.decodeUnknownOption(LifecycleTelemetryFromJson)(line.slice(telemetryPrefix.length))
    : Option.none<IngressLifecycleTelemetry>();

export const emitIngressLifecycleTelemetry = (enabled: boolean, event: IngressLifecycleTelemetry) =>
  enabled
    ? Effect.sync(() => console.log(`${telemetryPrefix}${JSON.stringify(event)}`))
    : Effect.void;

export const drainedTelemetry = (
  status: ThreadStreamLifecycleStatus,
  httpServerListening: boolean,
): IngressDrainTelemetry => ({ type: "drained", httpServerListening, status });

export const slowConsumerTelemetry = (
  status: ThreadStreamLifecycleStatus,
): IngressSlowConsumerTelemetry => ({ type: "connection_closed", reason: "slow_consumer", status });
