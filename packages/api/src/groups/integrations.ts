import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

export const IntegrationToolkit = Schema.Literals(["gmail", "googlecalendar", "googledrive"]);
export type IntegrationToolkit = typeof IntegrationToolkit.Type;

export const IntegrationConnectionSummary = Schema.Struct({
  connections: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      label: Schema.String,
      status: Schema.Literals(["connected", "missing", "stale", "unavailable"]),
      toolkit: IntegrationToolkit,
    }),
  ),
});
export type IntegrationConnectionSummary = typeof IntegrationConnectionSummary.Type;

export const IntegrationConnectRedirect = Schema.Struct({ url: Schema.URLFromString });
export const IntegrationConnectionChanged = Schema.Struct({
  status: Schema.Literal("missing"),
  toolkit: IntegrationToolkit,
});

export class IntegrationsUnavailable extends Schema.TaggedError<IntegrationsUnavailable>()(
  "IntegrationsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export const IntegrationsGroup = HttpApiGroup.make("integrations")
  .add(
    HttpApiEndpoint.get("inspect", "/v1/integrations", {
      error: IntegrationsUnavailable,
      success: IntegrationConnectionSummary,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Inspect integration connections" })),
  )
  .add(
    HttpApiEndpoint.post("connect", "/v1/integrations/connect", {
      error: IntegrationsUnavailable,
      payload: Schema.Struct({ toolkit: IntegrationToolkit }),
      success: IntegrationConnectRedirect,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Connect one integration" })),
  )
  .add(
    HttpApiEndpoint.post("disconnect", "/v1/integrations/disconnect", {
      error: IntegrationsUnavailable,
      payload: Schema.Struct({ toolkit: IntegrationToolkit }),
      success: IntegrationConnectionChanged,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Disconnect one integration" })),
  );
