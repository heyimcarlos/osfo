/* oxlint-disable effecttsgo/prefer-schema-over-json -- Tests inspect public JSON serialization for credential leaks and construct synthetic configuration. */
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";

import { loadConfig, type CloudflareEnv } from "../../src/config";

it("enables browser inventory only for an explicit complete local owner binding", () => {
  const configured = {
    ...env,
    INTEGRATION_PROVIDER_BASE_URL: "",
    RESEARCH_REPORT_PROVIDER_BASE_URL: "",
    BROWSER_HOST_ENDPOINT: "http://127.0.0.1:39270/inventory",
    BROWSER_HOST_OWNER_USER_ID: "test-owner",
    BROWSER_HOST_SESSION_ID: "test-extension-instance",
    BROWSER_HOST_TOKEN: "synthetic-test-token-with-32-characters",
    OSFO_STAGE: "test",
  };
  expect(loadConfig({ ...env, OSFO_STAGE: "test" }).browserHost).toBeNull();
  expect(loadConfig(configured).browserHost).toMatchObject({
    ownerUserId: "test-owner",
    hostSessionId: "test-extension-instance",
    allowedOrigins: [],
  });
  expect(loadConfig({ ...configured, BROWSER_HOST_TOKEN: "" }).browserHost).toBeNull();
  expect(
    loadConfig({ ...configured, BROWSER_HOST_ENDPOINT: "https://host.example/inventory" })
      .browserHost,
  ).toBeNull();
  expect(loadConfig({ ...configured, OSFO_STAGE: "preview" }).browserHost).toBeNull();
  expect(
    loadConfig({ ...configured, BROWSER_HOST_ALLOWED_ORIGINS: '["https://portal.example"]' })
      .browserHost?.allowedOrigins,
  ).toEqual(["https://portal.example"]);
  for (const origins of [
    '["https://portal.example/path"]',
    '["http://remote.example"]',
    "invalid",
  ]) {
    expect(
      loadConfig({ ...configured, BROWSER_HOST_ALLOWED_ORIGINS: origins }).browserHost,
    ).toBeNull();
  }
});

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

it("loads only complete production browser bindings and keeps unconfigured production disabled", () => {
  const production = {
    ...env,
    OSFO_STAGE: "production",
    COMPOSIO_API_KEY: "configured-for-browser-test",
    INTEGRATION_PROVIDER_BASE_URL: "",
    RESEARCH_REPORT_PROVIDER_BASE_URL: "",
    BROWSER_HOST_ENDPOINT: "",
    BROWSER_HOST_OWNER_USER_ID: "",
    BROWSER_HOST_SESSION_ID: "",
    BROWSER_HOST_TOKEN: "",
    BROWSER_HOST_ALLOWED_ORIGINS: "[]",
  };
  expect(loadConfig(production).browserHost).toBeNull();
  const configured = {
    ...production,
    BROWSER_HOST_ENDPOINT: "https://browser.example/inventory",
    BROWSER_HOST_OWNER_USER_ID: "test-owner",
    BROWSER_HOST_SESSION_ID: "test-extension-instance",
    BROWSER_HOST_TOKEN: "synthetic-test-token-with-32-characters",
    BROWSER_HOST_ALLOWED_ORIGINS: '["https://portal.example"]',
  };
  expect(loadConfig(configured).browserHost).toMatchObject({
    endpoint: configured.BROWSER_HOST_ENDPOINT,
    ownerUserId: configured.BROWSER_HOST_OWNER_USER_ID,
    hostSessionId: configured.BROWSER_HOST_SESSION_ID,
    allowedOrigins: ["https://portal.example"],
  });
  expect(JSON.stringify(loadConfig(configured).browserHost)).not.toContain(
    configured.BROWSER_HOST_TOKEN,
  );
  expect(() => loadConfig({ ...configured, BROWSER_HOST_TOKEN: "" })).toThrowError(
    "BROWSER_HOST bindings require",
  );
  expect(() =>
    loadConfig({ ...configured, BROWSER_HOST_ENDPOINT: "http://127.0.0.1:39270/inventory" }),
  ).toThrowError("BROWSER_HOST bindings require");
});
