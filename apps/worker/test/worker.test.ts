import { exports } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";

import { runInvocationEffect } from "../src/adapters/host";
import { decodeOsfoStage, decodeRuntimeConfig } from "../src/env";
import { makeWorkflowRuntime, probeExecutionUnit, RuntimeProbe } from "../src/layers";

describe("Osfo Cloudflare host", () => {
  it.effect("creates one Worker runtime for each request", () =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/health")),
      );
      const second = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/health")),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const firstProbe = yield* decodeRuntimeProbe(first);
      const secondProbe = yield* decodeRuntimeProbe(second);

      expect(firstProbe).toMatchObject({
        executionUnit: "worker",
        stage: "test",
      });
      expect(secondProbe.activationId).not.toBe(firstProbe.activationId);
    }),
  );

  it.effect("publishes the typed health contract in OpenAPI", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/openapi.json")),
      );
      const document = yield* Effect.promise(() => response.json());

      expect(response.status).toBe(200);
      expect(document).toMatchObject({
        info: { title: "Osfo API", version: "0.1.0" },
        paths: {
          "/health": { get: { operationId: "health.get" } },
          "/v1/registration": {
            put: { operationId: "registration.complete" },
          },
        },
      });
    }),
  );

  it.effect("verifies the Meta WhatsApp webhook challenge", () =>
    Effect.gen(function* () {
      const accepted = yield* Effect.promise(() =>
        exports.default.fetch(
          new Request(
            "https://osfo.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-only-meta-webhook-token&hub.challenge=challenge-174",
          ),
        ),
      );
      const rejected = yield* Effect.promise(() =>
        exports.default.fetch(
          new Request(
            "https://osfo.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-174",
          ),
        ),
      );

      expect(accepted.status).toBe(200);
      expect(yield* Effect.promise(() => accepted.text())).toBe("challenge-174");
      expect(rejected.status).toBe(403);
    }),
  );

  it.effect("returns only safe public responses for Meta signature failures", () =>
    Effect.gen(function* () {
      const body = '{"entry":[],"object":"whatsapp_business_account"}';
      const validHex = "293ba76ede55e6a948757a2a707815429f12481f8c6c93f07f2d5aa3edad288f";
      const accepted = yield* Effect.promise(() =>
        exports.default.fetch(
          new Request("https://osfo.test/webhooks/whatsapp", {
            body,
            headers: { "X-Hub-Signature-256": `sha256=${validHex}` },
            method: "POST",
          }),
        ),
      );
      const signatures = [
        null,
        `sha256=1${validHex.slice(1)}`,
        `sha1=${validHex}`,
        `sha256=${"z".repeat(64)}`,
        `sha256=${validHex.slice(1)}`,
        `sha256=${validHex}00`,
      ] as const;
      const rejected = yield* Effect.forEach(signatures, (signature) => {
        const headers = new Headers();
        if (signature !== null) headers.set("X-Hub-Signature-256", signature);
        return Effect.promise(() =>
          exports.default.fetch(
            new Request("https://osfo.test/webhooks/whatsapp", {
              body,
              headers,
              method: "POST",
            }),
          ),
        );
      });
      const rejectedBodies = yield* Effect.forEach(rejected, (response) =>
        Effect.promise(() => response.text()),
      );

      expect(accepted.status).toBe(200);
      expect(yield* Effect.promise(() => accepted.text())).toBe("EVENT_RECEIVED");
      expect(rejected.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401]);
      expect(rejectedBodies).toEqual([
        "Unauthorized",
        "Unauthorized",
        "Unauthorized",
        "Unauthorized",
        "Unauthorized",
        "Unauthorized",
      ]);
    }),
  );

  it.effect("reuses one runtime inside an Osfo Agent activation", () =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/agents/agent-1/health")),
      );
      const second = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/agents/agent-1/health")),
      );
      const other = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/agents/agent-2/health")),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(other.status).toBe(200);

      const firstProbe = yield* decodeRuntimeProbe(first);
      const secondProbe = yield* decodeRuntimeProbe(second);
      const otherProbe = yield* decodeRuntimeProbe(other);

      expect(firstProbe).toMatchObject({
        executionUnit: "osfo-agent",
        identity: "agent-1",
        stage: "test",
      });
      expect(secondProbe.activationId).toBe(firstProbe.activationId);
      expect(otherProbe.activationId).not.toBe(firstProbe.activationId);
    }),
  );

  it.effect("creates a restricted runtime for each registration dialogue", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        exports.default.fetch(
          new Request("https://osfo.test/registration-dialogues/invitation-1/health"),
        ),
      );

      expect(response.status).toBe(200);
      const probe = yield* decodeRuntimeProbe(response);
      expect(probe).toMatchObject({
        executionUnit: "registration-dialogue",
        identity: "invitation-1",
        stage: "test",
      });
    }),
  );

  it.effect("creates and disposes one runtime for each Workflow callback", () =>
    Effect.gen(function* () {
      const firstResult = yield* Effect.promise(() =>
        runInvocationEffect(makeWorkflowRuntime("workflow-1", "test"), probeExecutionUnit),
      );
      const secondResult = yield* Effect.promise(() =>
        runInvocationEffect(makeWorkflowRuntime("workflow-1", "test"), probeExecutionUnit),
      );

      expect(firstResult).toMatchObject({
        executionUnit: "workflow",
        identity: "workflow-1",
        stage: "test",
      });
      expect(secondResult.activationId).not.toBe(firstResult.activationId);
    }),
  );

  it("accepts preview behavior but rejects infrastructure stage names", () => {
    expect(Option.isSome(decodeOsfoStage("preview"))).toBe(true);
    expect(Option.isNone(decodeOsfoStage("pr-212"))).toBe(true);
  });

  it("decodes complete authentication configuration without exposing secrets", () => {
    const decoded = decodeRuntimeConfig({
      BETTER_AUTH_API_KEY: "test-only-better-auth-dashboard-api-key",
      BETTER_AUTH_BASE_URL: "https://osfo.test",
      BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters",
      BETTER_AUTH_TRUSTED_ORIGINS: '["https://osfo.test"]',
      META_APP_SECRET: "test-only-meta-app-secret",
      META_WEBHOOK_VERIFY_TOKEN: "test-only-meta-webhook-token",
      OSFO_STAGE: "test",
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "test-only-twilio-token",
      TWILIO_VERIFY_SERVICE_SID: `VA${"2".repeat(32)}`,
      WHATSAPP_PHONE_NUMBER: "14165550100",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    expect(String(decoded)).not.toContain("test-only-better-auth-dashboard-api-key");
    expect(String(decoded)).not.toContain("test-only-twilio-token");
    expect(String(decoded)).not.toContain("test-only-better-auth-secret");
    expect(String(decoded)).not.toContain("test-only-meta-app-secret");
    expect(String(decoded)).not.toContain("test-only-meta-webhook-token");
  });

  it("rejects incomplete authentication configuration", () => {
    expect(Result.isFailure(decodeRuntimeConfig({ OSFO_STAGE: "test" }))).toBe(true);
  });

  it("enables Telegram only with complete non-production configuration and redacts secrets", () => {
    const decoded = decodeRuntimeConfig({
      ...completeRuntimeInput,
      TELEGRAM_ALLOWED_USER_IDS: "12345,67890",
      TELEGRAM_BOT_TOKEN: "telegram-test-bot-token",
      TELEGRAM_BOT_USERNAME: "osfo_test_bot",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "telegram_test_webhook_secret",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    expect(Result.getOrThrow(decoded).telegram).toMatchObject({
      allowedUserIds: ["12345", "67890"],
      botUsername: "osfo_test_bot",
      kind: "enabled",
    });
    expect(String(decoded)).not.toContain("telegram-test-bot-token");
    expect(String(decoded)).not.toContain("telegram_test_webhook_secret");
  });

  it("rejects partial Telegram configuration and all production activation", () => {
    expect(
      Result.isFailure(
        decodeRuntimeConfig({ ...completeRuntimeInput, TELEGRAM_BOT_TOKEN: "partial" }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeRuntimeConfig({
          ...completeRuntimeInput,
          OSFO_STAGE: "production",
          TELEGRAM_ALLOWED_USER_IDS: "12345",
          TELEGRAM_BOT_TOKEN: "telegram-test-bot-token",
          TELEGRAM_BOT_USERNAME: "osfo_test_bot",
          TELEGRAM_WEBHOOK_SECRET_TOKEN: "telegram_test_webhook_secret",
        }),
      ),
    ).toBe(true);
  });
});

const completeRuntimeInput = {
  BETTER_AUTH_API_KEY: "test-only-better-auth-dashboard-api-key",
  BETTER_AUTH_BASE_URL: "https://osfo.test",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters",
  BETTER_AUTH_TRUSTED_ORIGINS: '["https://osfo.test"]',
  META_APP_SECRET: "test-only-meta-app-secret",
  META_WEBHOOK_VERIFY_TOKEN: "test-only-meta-webhook-token",
  OSFO_STAGE: "test",
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "test-only-twilio-token",
  TWILIO_VERIFY_SERVICE_SID: `VA${"2".repeat(32)}`,
  WHATSAPP_PHONE_NUMBER: "14165550100",
} as const;

const decodeRuntimeProbe = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(RuntimeProbe)(body)),
  );
