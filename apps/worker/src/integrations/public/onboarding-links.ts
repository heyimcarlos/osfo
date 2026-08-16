import { Layer, Redacted } from "effect";

import * as Onboarding from "../../services/onboarding";

/** Configuration owned by the public onboarding URL adapter. */
export interface Options {
  readonly officialWhatsAppNumber: string;
  readonly publicBaseUrl: URL;
}

/** Project onboarding outcomes into public web and WhatsApp URLs. */
export const layer = (options: Options) =>
  Layer.succeed(
    Onboarding.OnboardingLinks,
    Onboarding.OnboardingLinks.of({
      enrollment: (token) =>
        new URL(
          `https://wa.me/${options.officialWhatsAppNumber}?text=${encodeURIComponent(`OSFO ENROLL ${Redacted.value(token)}`)}`,
        ),
      registrationHome: () => new URL("/get-started", options.publicBaseUrl),
      verification: (token) => new URL(`/verify/${Redacted.value(token)}`, options.publicBaseUrl),
    }),
  );
