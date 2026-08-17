import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";
import { AgentId, UserId } from "./registration";

/** Launch setup choices that may shape the first personal response. */
export const HelpArea = Schema.Literals([
  "writing-email",
  "scheduling-reminders",
  "research",
  "files-documents",
  "money-planning",
  "something-else",
]);

/** Launch setup choice accepted by the onboarding API. */
export type HelpArea = typeof HelpArea.Type;

/** Launch web locales. */
export const OnboardingLocale = Schema.Literals(["en", "es"]);

/** Launch web locale accepted by the onboarding API. */
export type OnboardingLocale = typeof OnboardingLocale.Type;

/** High-entropy secret that continues one finite-lived Registration Invitation. */
export const RegistrationToken = Schema.String.check(
  Schema.makeFilter((value) => /^[0-9a-f]{64}$/u.test(value) || "must be a 64-character token"),
).pipe(Schema.brand("RegistrationToken"));

/** High-entropy secret that continues one finite-lived Registration Invitation. */
export type RegistrationToken = typeof RegistrationToken.Type;

/** Public resumable Registration Invitation state. */
export const InvitationResponse = Schema.Struct({
  locale: OnboardingLocale,
  maskedPhoneNumber: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.Literals(["telegram", "whatsapp"])),
  state: Schema.Literals(["live", "expired", "consumed", "invalid"]),
});

/** Safe public state for one resumable Registration Invitation. */
export type InvitationResponse = typeof InvitationResponse.Type;

/** Stable wire identity for one Channel Binding. */
export const ChannelBindingId = Schema.String.pipe(Schema.brand("ChannelBindingId"));

/** Stable wire identity for one Channel Binding. */
export type ChannelBindingId = typeof ChannelBindingId.Type;

/** Channel result after onboarding completes. */
export const ChannelOnboardingResponse = Schema.Union([
  Schema.TaggedStruct("BindingCreated", { channelBindingId: ChannelBindingId }),
  Schema.TaggedStruct("BindingExisting", { channelBindingId: ChannelBindingId }),
  Schema.TaggedStruct("ConsentRefused", {}),
  Schema.TaggedStruct("EnrollmentPending", { enrollmentUrl: Schema.URLFromString }),
  Schema.TaggedStruct("ProfileConfirmationPending", {}),
]);

/** Channel result after onboarding completes or waits for profile confirmation. */
export type ChannelOnboardingResponse = typeof ChannelOnboardingResponse.Type;

/** Authenticated product registration and channel result. */
export const OnboardingResponse = Schema.Struct({
  agentId: AgentId,
  channel: ChannelOnboardingResponse,
  completedAt: Schema.DateFromString,
  profileConfirmationRequired: Schema.Boolean,
  userId: UserId,
});

/** Authenticated product registration and channel result. */
export type OnboardingResponse = typeof OnboardingResponse.Type;

/** Safe invitation recovery response. */
export class InvitationUnavailable extends Schema.TaggedError<InvitationUnavailable>()(
  "InvitationUnavailable",
  { message: Schema.String },
  { httpApiStatus: 410 },
) {}

/** Safe fail-closed Channel Binding response. */
export class ChannelBindingNeedsSupport extends Schema.TaggedError<ChannelBindingNeedsSupport>()(
  "ChannelBindingNeedsSupport",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Safe response for unavailable onboarding dependencies. */
export class OnboardingUnavailable extends Schema.TaggedError<OnboardingUnavailable>()(
  "OnboardingUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Safe response when the session has no verified Phone Account. */
export class PhoneVerificationRequired extends Schema.TaggedError<PhoneVerificationRequired>()(
  "PhoneVerificationRequired",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

const CompletePayload = Schema.Struct({
  bindingConsent: Schema.Literals(["accepted", "refused", "web-enrollment"]),
  existingProfileChoice: Schema.NullOr(Schema.Literals(["apply", "keep"])),
  helpAreas: Schema.Array(HelpArea),
  invitationToken: Schema.NullOr(RegistrationToken),
  locale: OnboardingLocale,
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

/** Public invitation inspection and authenticated onboarding completion. */
export const OnboardingGroup = HttpApiGroup.make("onboarding")
  .add(
    HttpApiEndpoint.get("inspectInvitation", "/v1/onboarding/invitations/:token", {
      error: OnboardingUnavailable,
      params: { token: RegistrationToken },
      success: InvitationResponse,
    }).annotateMerge(
      OpenApi.annotations({
        description: "Resume one finite-lived phone verification invitation.",
        identifier: "onboarding.inspectInvitation",
        summary: "Inspect Registration Invitation",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("complete", "/v1/onboarding", {
      error: [
        InvitationUnavailable,
        ChannelBindingNeedsSupport,
        PhoneVerificationRequired,
        OnboardingUnavailable,
      ],
      payload: CompletePayload,
      success: OnboardingResponse,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Complete phone-first setup and prepare or create a Channel Binding.",
          identifier: "onboarding.complete",
          summary: "Complete onboarding",
        }),
      ),
  );
