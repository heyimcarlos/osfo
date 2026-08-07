import { Context, Schema, type Effect } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { RequestValidation, Uuid } from "./threads/api.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const DevelopmentDemoSessionRequest = Schema.Struct({
  accessCode: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)),
}).annotate(strict);

export type DevelopmentDemoSessionRequest = typeof DevelopmentDemoSessionRequest.Type;

export class DevelopmentDemoSession extends Schema.Class<DevelopmentDemoSession>(
  "DevelopmentDemoSession",
)(
  {
    authenticationToken: Schema.NonEmptyString,
    expiresAt: Schema.String.check(
      Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    ),
    productionQualification: Schema.Literal("MISSING"),
    protocolVersion: Schema.Literal(1),
    scope: Schema.Literal("development"),
    threadId: Uuid,
  },
  strict,
) {}

export class DevelopmentBootstrapCapability extends Schema.Class<DevelopmentBootstrapCapability>(
  "DevelopmentBootstrapCapability",
)(
  {
    enabled: Schema.Literal(true),
    productionQualification: Schema.Literal("MISSING"),
    scope: Schema.Literal("development"),
  },
  strict,
) {}

export class DevelopmentBootstrapRejected extends Schema.TaggedErrorClass<DevelopmentBootstrapRejected>()(
  "DevelopmentBootstrapRejected",
  {},
  { httpApiStatus: 404 },
) {}

export class DevelopmentBootstrapRateLimited extends Schema.TaggedErrorClass<DevelopmentBootstrapRateLimited>()(
  "DevelopmentBootstrapRateLimited",
  { retryAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })) },
  { httpApiStatus: 429 },
) {}

export class DevelopmentBootstrapUnavailable extends Schema.TaggedErrorClass<DevelopmentBootstrapUnavailable>()(
  "DevelopmentBootstrapUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

export type DevelopmentDemoBootstrapError =
  | DevelopmentBootstrapRejected
  | DevelopmentBootstrapRateLimited
  | DevelopmentBootstrapUnavailable;

export class DevelopmentDemoBootstrap extends Context.Service<
  DevelopmentDemoBootstrap,
  {
    readonly create: (
      request: DevelopmentDemoSessionRequest,
    ) => Effect.Effect<DevelopmentDemoSession, DevelopmentDemoBootstrapError>;
  }
>()("@osfo/api/DevelopmentDemoBootstrap") {}

export const DevelopmentBootstrapGroup = HttpApiGroup.make("developmentBootstrap")
  .add(
    HttpApiEndpoint.get("getCapability", "/v1/development/demo-sessions/capability", {
      success: DevelopmentBootstrapCapability,
    }),
  )
  .add(
    HttpApiEndpoint.post("createDemoSession", "/v1/development/demo-sessions", {
      headers: {
        "x-osfo-demo-bootstrap-code": Schema.String.check(Schema.isNonEmpty()).check(
          Schema.isMaxLength(256),
        ),
      },
      success: DevelopmentDemoSession,
      error: [
        DevelopmentBootstrapRejected,
        DevelopmentBootstrapRateLimited,
        DevelopmentBootstrapUnavailable,
      ],
    }),
  )
  .middleware(RequestValidation)
  .annotateMerge(
    OpenApi.annotations({
      title: "Development demo bootstrap",
      description: "Creates one development-only browser authority bundle.",
    }),
  );

export const DevelopmentBootstrapApi = HttpApi.make("osfoDevelopmentBootstrap").add(
  DevelopmentBootstrapGroup,
);
