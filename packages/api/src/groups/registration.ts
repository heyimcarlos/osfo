import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

/** Stable wire identity for one Osfo User. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));

/** Stable wire identity for one Osfo User. */
export type UserId = typeof UserId.Type;

/** Stable wire identity for one User-scoped Osfo Agent. */
export const AgentId = Schema.String.pipe(Schema.brand("AgentId"));

/** Stable wire identity for one User-scoped Osfo Agent. */
export type AgentId = typeof AgentId.Type;

/** Completed registration returned by the control-plane API. */
export const RegistrationResponse = Schema.Struct({
  agentId: AgentId,
  completedAt: Schema.DateFromString,
  userId: UserId,
});

/** Completed registration returned by the control-plane API. */
export type RegistrationResponse = typeof RegistrationResponse.Type;

/** Safe response when registration cannot be completed. */
export class RegistrationUnavailable extends Schema.TaggedError<RegistrationUnavailable>()(
  "RegistrationUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Authenticated registration contract for the Osfo control plane. */
export const RegistrationGroup = HttpApiGroup.make("registration").add(
  HttpApiEndpoint.put("complete", "/v1/me/registration", {
    error: RegistrationUnavailable,
    payload: Schema.Struct({}),
    success: RegistrationResponse,
  })
    .middleware(Auth)
    .annotateMerge(
      OpenApi.annotations({
        description: "Provision every required resource for the authenticated User.",
        identifier: "registration.complete",
        summary: "Complete User registration",
      }),
    ),
);
