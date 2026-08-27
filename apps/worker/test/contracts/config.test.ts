import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";

import { loadConfig, type CloudflareEnv } from "../../src/config";

it("rejects a malformed nonempty Company Conversation daily limit", () => {
  expect(() =>
    loadConfig({ ...env, COMPANY_CONVERSATION_DAILY_TURN_LIMIT: "not-a-number" }),
  ).toThrowError(
    "Worker configuration is invalid: COMPANY_CONVERSATION_DAILY_TURN_LIMIT must contain a positive integer",
  );
});

it("keeps WhatsApp Wake-up inactive unless the exact policy attestation is present", () => {
  const configuredEnv: CloudflareEnv = env;
  const {
    WHATSAPP_WAKEUP_TEMPLATE_APPROVAL: approval,
    WHATSAPP_WAKEUP_TEMPLATE_NAME: templateName,
    WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION: policyVersion,
    ...inactiveEnv
  } = configuredEnv;
  expect([approval, templateName, policyVersion]).toEqual([
    "approved:whatsapp-wakeup-v1:osfo_update:en,es",
    "osfo_update",
    "whatsapp-wakeup-v1",
  ]);
  expect(loadConfig(inactiveEnv).whatsApp.wakeUp).toEqual({ _tag: "Inactive" });
  expect(
    loadConfig({
      ...env,
      WHATSAPP_WAKEUP_TEMPLATE_APPROVAL: "approved:whatsapp-wakeup-v1:wrong:en,es",
      WHATSAPP_WAKEUP_TEMPLATE_NAME: "osfo_update",
      WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION: "whatsapp-wakeup-v1",
    }).whatsApp.wakeUp,
  ).toEqual({ _tag: "Inactive" });

  expect(
    loadConfig({
      ...env,
      WHATSAPP_WAKEUP_TEMPLATE_APPROVAL: "approved:whatsapp-wakeup-v1:promo_link:en,es",
      WHATSAPP_WAKEUP_TEMPLATE_NAME: "promo_link",
    }).whatsApp.wakeUp,
  ).toEqual({ _tag: "Inactive" });
  expect(
    loadConfig({
      ...env,
      WHATSAPP_WAKEUP_TEMPLATE_APPROVAL: "approved:whatsapp-wakeup-v1:osfo_update:en,es",
      WHATSAPP_WAKEUP_TEMPLATE_NAME: "osfo_update",
      WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION: "whatsapp-wakeup-v1",
    }).whatsApp.wakeUp,
  ).toEqual({
    _tag: "Active",
    templateName: "osfo_update",
    templatePolicyVersion: "whatsapp-wakeup-v1",
  });
});
