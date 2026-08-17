import { Layer, Redacted } from "effect";

import * as Onboarding from "../../services/onboarding";

/** Configuration owned by the public onboarding URL adapter. */
export interface Options {
  readonly enrollmentProvider: Onboarding.ChannelProvider;
  readonly officialWhatsAppNumber: string;
  readonly publicBaseUrl: URL;
  readonly telegramBotUsername: string;
}

/** Project onboarding outcomes into public web, WhatsApp, and Telegram URLs. */
export const layer = (options: Options) =>
  Layer.succeed(
    Onboarding.OnboardingLinks,
    Onboarding.OnboardingLinks.of({
      enrollment: (token) =>
        options.enrollmentProvider === "telegram"
          ? {
              provider: "telegram",
              url: new URL(
                `https://t.me/${options.telegramBotUsername}?start=${Redacted.value(token)}`,
              ),
            }
          : {
              provider: "whatsapp",
              url: new URL(
                `https://wa.me/${options.officialWhatsAppNumber}?text=${encodeURIComponent(`OSFO ENROLL ${Redacted.value(token)}`)}`,
              ),
            },
      registrationHome: () => new URL("/get-started", options.publicBaseUrl),
      verification: (token) => new URL(`/verify/${Redacted.value(token)}`, options.publicBaseUrl),
    }),
  );
