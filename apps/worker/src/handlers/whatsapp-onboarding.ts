import { Effect } from "effect";

import type * as Onboarding from "../services/onboarding";
import type { WhatsAppOnboardingCommand } from "../services/whatsapp-onboarding";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

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
