import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

/** Observable identity of the request-scoped Worker runtime. */
export const HealthResponse = Schema.Struct({
  activationId: Schema.String,
  executionUnit: Schema.Literal("worker"),
  identity: Schema.Literal("request"),
  kind: Schema.Literal("RuntimeProbe"),
  stage: Schema.Literals(["development", "preview", "test", "production"]),
});

/** Observable identity of the request-scoped Worker runtime. */
export type HealthResponse = typeof HealthResponse.Type;

/** Public health contract for the Osfo API. */
export const HealthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("get", "/health", {
    success: HealthResponse,
  }).annotateMerge(
    OpenApi.annotations({
      description: "Check whether the Osfo Worker can handle requests.",
      identifier: "health.get",
      summary: "Check Worker health",
    }),
  ),
);
