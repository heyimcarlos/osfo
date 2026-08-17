import { Schema } from "effect";

import * as Onboarding from "./onboarding";

/** Closed onboarding command produced from provider-authenticated WhatsApp facts. */
export const WhatsAppOnboardingCommand = Schema.Union([
  Schema.TaggedStruct("UnknownSenderMessage", {
    channelIdentity: Onboarding.UnknownWhatsAppMessage.fields.channelIdentity,
    eventId: Schema.String,
    invitedPhoneNumber: Schema.String,
    locale: Onboarding.OnboardingLocale,
    message: Schema.String,
  }),
  Schema.TaggedStruct("EnrollmentControlMessage", {
    channelIdentity: Onboarding.WhatsAppEnrollment.fields.channelIdentity,
    eventId: Schema.String,
    token: Onboarding.WhatsAppEnrollment.fields.token,
  }),
]);

/** Closed onboarding command produced from provider-authenticated WhatsApp facts. */
export type WhatsAppOnboardingCommand = typeof WhatsAppOnboardingCommand.Type;
