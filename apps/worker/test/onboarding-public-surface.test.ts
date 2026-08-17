import { describe, expect, it } from "@effect/vitest";

import type * as Onboarding from "../src/services/onboarding";

type GenericInvitationOperation = Extract<
  keyof Onboarding.Interface | keyof Onboarding.PersistencePort,
  "insertChannel" | "issueChannelInvitation"
>;

type WhatsAppInvitationPersistenceInput = Parameters<
  Onboarding.PersistencePort["insertWhatsAppInvitation"]
>[0];

type ConfigurableTransportFacts = Extract<
  keyof WhatsAppInvitationPersistenceInput,
  "kind" | "provider"
>;

const noGenericInvitationOperation: Record<GenericInvitationOperation, never> = {};
const noConfigurableTransportFacts: Record<ConfigurableTransportFacts, never> = {};

describe("onboarding public surface", () => {
  it("keeps invitation issuance concrete to WhatsApp", () => {
    const requiredPhoneFact: Pick<WhatsAppInvitationPersistenceInput, "invitedPhoneNumber"> = {
      invitedPhoneNumber: "+14165550199",
    };

    expect(noGenericInvitationOperation).toEqual({});
    expect(noConfigurableTransportFacts).toEqual({});
    expect(requiredPhoneFact).toEqual({ invitedPhoneNumber: "+14165550199" });
  });
});
