import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

/** Public status of the authenticated User's Gmail Integration Connection. */
export const GmailConnectionResponse = Schema.Struct({
  connectionId: Schema.NullOr(Schema.String),
  providerAccountId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["connected", "dormant", "notConnected", "revoked"]),
});

/** Public status of the authenticated User's Gmail Integration Connection. */
export type GmailConnectionResponse = typeof GmailConnectionResponse.Type;

/** Safe response when current policy denies a Gmail connection operation. */
export class GmailConnectionDenied extends Schema.TaggedError<GmailConnectionDenied>()(
  "GmailConnectionDenied",
  { reason: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Safe response when Gmail connection state cannot be read or changed. */
export class GmailConnectionUnavailable extends Schema.TaggedError<GmailConnectionUnavailable>()(
  "GmailConnectionUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Stable safe response when linked Google facts conflict with connection authority. */
export class GmailConnectionConflict extends Schema.TaggedError<GmailConnectionConflict>()(
  "GmailConnectionConflict",
  { reason: Schema.Literal("connectionConflict") },
  { httpApiStatus: 409 },
) {}

const endpoint = {
  error: [GmailConnectionConflict, GmailConnectionDenied, GmailConnectionUnavailable] as const,
  success: GmailConnectionResponse,
};

/** Authenticated Gmail connection control-plane contract. */
export const GmailGroup = HttpApiGroup.make("gmail")
  .add(
    HttpApiEndpoint.get("inspectConnection", "/v1/gmail/connection", endpoint)
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Inspect the Gmail connection" })),
  )
  .add(
    HttpApiEndpoint.put("completeConnection", "/v1/gmail/connection", {
      ...endpoint,
      payload: Schema.Struct({}),
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Complete Gmail OAuth connection" })),
  )
  .add(
    HttpApiEndpoint.delete("revokeConnection", "/v1/gmail/connection", endpoint)
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Revoke the Gmail connection" })),
  );
