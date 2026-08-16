import { Effect, Schema } from "effect";

import * as Onboarding from "../services/onboarding";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

/** Closed command facts supplied after a future Meta adapter verifies and decodes an event. */
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

/** Closed onboarding command accepted from the future provider-authenticated Meta adapter. */
export type WhatsAppOnboardingCommand = typeof WhatsAppOnboardingCommand.Type;

/** Route verified provider facts without treating enrollment control as a UserMessage. */
export const handleWhatsAppOnboardingCommand = Effect.fn("WhatsAppOnboarding.handleCommand")(
  function* (onboarding: Onboarding.Interface, command: WhatsAppOnboardingCommand) {
    if (command._tag === "UnknownSenderMessage") {
      const invitation = yield* onboarding.issueWhatsAppInvitation(command);
      return { _tag: "InvitationIssued", invitation } as const;
    }
    const channel = yield* onboarding.enrollWhatsApp(command);
    return { _tag: "EnrollmentCompleted", channel } as const;
  },
);
