import { describe, expect, it } from "@effect/vitest";

import { ChannelIdentity } from "../src/domain";
import type { Onboarding } from "../src/services/onboarding";

/* oxlint-disable eslint/no-underscore-dangle -- Effect domain unions use the standard _tag discriminator. */

type ChannelInvitationOperation = Extract<
  keyof Onboarding.Interface | keyof Onboarding.Persistence,
  "insertChannelInvitation" | "issueChannelInvitation"
>;

type ChannelInvitationPersistenceInput = Parameters<
  Onboarding.Persistence["insertChannelInvitation"]
>[0];

type ConfigurableTransportFacts = Extract<
  keyof ChannelInvitationPersistenceInput,
  "kind" | "provider"
>;

const channelInvitationOperations = {
  insertChannelInvitation: true,
  issueChannelInvitation: true,
} satisfies Record<ChannelInvitationOperation, true>;
const noConfigurableTransportFacts: Record<ConfigurableTransportFacts, never> = {};

describe("onboarding public surface", () => {
  it("models channel-first invitations without configurable transport facts", () => {
    const telegram: Onboarding.ChannelFirstInvitation = {
      _tag: "TelegramFirst",
      channelIdentity: ChannelIdentity.make("telegram:test"),
    };
    const whatsApp: Onboarding.ChannelFirstInvitation = {
      _tag: "WhatsAppFirst",
      channelIdentity: ChannelIdentity.make("+14165550199"),
      invitedPhoneNumber: "+14165550199",
    };

    expect(channelInvitationOperations).toEqual({
      insertChannelInvitation: true,
      issueChannelInvitation: true,
    });
    expect(noConfigurableTransportFacts).toEqual({});
    expect(telegram._tag).toBe("TelegramFirst");
    expect(whatsApp._tag).toBe("WhatsAppFirst");
  });
});
