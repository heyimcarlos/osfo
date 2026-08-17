import { telegramOnboardingDeliveries } from "@osfo/db/schema/telegram-onboarding-delivery";
import { describe, expect, it } from "@effect/vitest";
import { getTableName } from "drizzle-orm";

import type * as SharedOnboardingSchema from "@osfo/db/schema/onboarding";
import type { TelegramWebhookOptions } from "../src/handlers/telegram-webhook";
import type * as Onboarding from "../src/services/onboarding";
import type * as TelegramDelivery from "../src/services/telegram-onboarding-delivery";

type WhatsAppInvitationCapability = "insertWhatsAppInvitation" | "issueWhatsAppInvitation";

type TelegramDeliveryCapabilityLeak = Extract<
  keyof TelegramDelivery.InvitationPersistencePort | keyof TelegramDelivery.PersistencePort,
  WhatsAppInvitationCapability
>;

type TelegramWebhookCapabilityLeak = Extract<
  keyof TelegramWebhookOptions["delivery"] | keyof TelegramWebhookOptions["onboarding"],
  WhatsAppInvitationCapability
>;

type SharedDeliveryApi = Extract<
  keyof Onboarding.Interface,
  | "beginTelegramEvent"
  | "completeTelegramEvent"
  | "issueTelegramInvitation"
  | "markTelegramEventAmbiguous"
>;

type SharedDeliverySchema = Extract<
  keyof typeof SharedOnboardingSchema,
  "telegramOnboardingDeliveries"
>;

const noSharedDeliveryApi: Record<SharedDeliveryApi, never> = {};
const noSharedDeliverySchema: Record<SharedDeliverySchema, never> = {};
const noTelegramDeliveryCapabilityLeak: Record<TelegramDeliveryCapabilityLeak, never> = {};
const noTelegramWebhookCapabilityLeak: Record<TelegramWebhookCapabilityLeak, never> = {};

describe("Telegram onboarding delivery ownership", () => {
  it("owns the delivery lifecycle outside shared onboarding", () => {
    const operations: ReadonlyArray<keyof TelegramDelivery.Interface> = [
      "beginEvent",
      "completeEvent",
      "issueInvitation",
      "markEventAmbiguous",
    ];

    expect(operations).toHaveLength(4);
    expect(getTableName(telegramOnboardingDeliveries)).toBe("telegram_onboarding_deliveries");
    expect(noSharedDeliveryApi).toEqual({});
    expect(noSharedDeliverySchema).toEqual({});
    expect(noTelegramDeliveryCapabilityLeak).toEqual({});
    expect(noTelegramWebhookCapabilityLeak).toEqual({});
  });
});
