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

/** Launch setup choices that shape the registered User profile. */
export const HelpArea = Schema.Literals([
  "writing-email",
  "scheduling-reminders",
  "research",
  "files-documents",
  "money-planning",
  "something-else",
]);

export type HelpArea = typeof HelpArea.Type;

/** Supported locale for registration setup. */
export const RegistrationLocale = Schema.Literals(["en", "es"]);

export type RegistrationLocale = typeof RegistrationLocale.Type;

/** Profile choices committed with User registration. */
export const RegistrationProfile = Schema.Struct({
  helpAreas: Schema.Array(HelpArea),
  locale: RegistrationLocale,
  preferredName: Schema.NullOr(
    Schema.String.check(
      Schema.makeFilter(
        (value) =>
          (value.trim().length > 0 && value.trim().length <= 80) ||
          "must contain between 1 and 80 characters",
      ),
    ),
  ),
});

export type RegistrationProfile = typeof RegistrationProfile.Type;

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

/** Stable denial when the authenticated User has not verified a phone number. */
export class RegistrationPhoneVerificationRequired extends Schema.TaggedError<RegistrationPhoneVerificationRequired>()(
  "RegistrationPhoneVerificationRequired",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Authenticated registration contract for the Osfo control plane. */
export const RegistrationGroup = HttpApiGroup.make("registration").add(
  HttpApiEndpoint.put("complete", "/v1/registration", {
    error: [RegistrationPhoneVerificationRequired, RegistrationUnavailable],
    payload: RegistrationProfile,
    success: RegistrationResponse,
  })
    .middleware(Auth)
    .annotateMerge(
      OpenApi.annotations({
        description:
          "Commit setup and provision every required resource for the authenticated User.",
        identifier: "registration.complete",
        summary: "Complete User registration",
      }),
    ),
);
