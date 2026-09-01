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

it("admits only an explicit loopback Research provider in test or development", () => {
  expect(
    loadConfig({
      ...env,
      OSFO_STAGE: "test",
      RESEARCH_REPORT_PROVIDER_BASE_URL: "http://127.0.0.1:43123",
    }).researchReportProvider,
  ).toEqual({ _tag: "LocalVerification", baseURL: "http://127.0.0.1:43123/" });
  expect(() =>
    loadConfig({
      ...env,
      // This assertion owns Research configuration. The composed journey environment also
      // provides a local Integration origin, which is independently invalid in production.
      COMPOSIO_API_KEY: "configured-for-research-test",
      INTEGRATION_PROVIDER_BASE_URL: "",
      OSFO_STAGE: "production",
      RESEARCH_REPORT_PROVIDER_BASE_URL: "http://127.0.0.1:43123",
    }),
  ).toThrowError(
    "Worker configuration is invalid: RESEARCH_REPORT_PROVIDER_BASE_URL is restricted to local verification",
  );
  expect(() =>
    loadConfig({
      ...env,
      OSFO_STAGE: "test",
      RESEARCH_REPORT_PROVIDER_BASE_URL: "https://provider.example.com",
    }),
  ).toThrowError(
    "Worker configuration is invalid: RESEARCH_REPORT_PROVIDER_BASE_URL must use a loopback host",
  );
});

it("admits only an explicit loopback Integration provider in test or development", () => {
  const configuredEnv: CloudflareEnv = { ...env, COMPOSIO_API_KEY: "omitted-for-local-test" };
  const { COMPOSIO_API_KEY: omittedComposioKey, ...envWithoutComposio } = configuredEnv;
  expect(omittedComposioKey).toBe("omitted-for-local-test");
  expect(
    loadConfig({
      ...envWithoutComposio,
      INTEGRATION_PROVIDER_BASE_URL: "http://127.0.0.1:43124",
      OSFO_STAGE: "development",
    }).integrationProvider,
  ).toEqual({ _tag: "LocalVerification", baseURL: "http://127.0.0.1:43124/" });
  expect(() =>
    loadConfig({
      ...envWithoutComposio,
      INTEGRATION_PROVIDER_BASE_URL: "http://127.0.0.1:43124",
      OSFO_STAGE: "production",
    }),
  ).toThrowError(
    "Worker configuration is invalid: INTEGRATION_PROVIDER_BASE_URL is restricted to local verification",
  );
  expect(() =>
    loadConfig({
      ...envWithoutComposio,
      INTEGRATION_PROVIDER_BASE_URL: "https://provider.example.com",
      OSFO_STAGE: "test",
    }),
  ).toThrowError(
    "Worker configuration is invalid: INTEGRATION_PROVIDER_BASE_URL must use a loopback host",
  );
});

it("rejects simultaneous local Integration verification and Composio credentials", () => {
  expect(() =>
    loadConfig({
      ...env,
      COMPOSIO_API_KEY: "must-not-be-retained",
      INTEGRATION_PROVIDER_BASE_URL: "http://127.0.0.1:43124",
      OSFO_STAGE: "test",
    }),
  ).toThrowError(
    "Worker configuration is invalid: COMPOSIO_API_KEY cannot be configured with INTEGRATION_PROVIDER_BASE_URL",
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
