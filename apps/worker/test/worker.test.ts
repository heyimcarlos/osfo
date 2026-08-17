import { exports } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, env } from "cloudflare:test";
import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { runInvocationEffect } from "../src/adapters/host";
import { makeWorkflowRuntime, probeExecutionUnit, RuntimeProbe } from "../src/layers";
import worker from "../src/worker";

describe("Osfo Cloudflare host", () => {
  // oxlint-disable-next-line effecttsgo/async-function -- Test covers the Promise-based Worker host interface.
  it("logs safe configuration failures and returns a generic response", async () => {
    const secret = "short-secret-do-not-log";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(new Request("https://osfo.test/health"), {
      ...env,
      BETTER_AUTH_SECRET: secret,
    });
    const evidence = error.mock.calls.flat().join(" ");
    error.mockRestore();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "The Worker runtime configuration is invalid",
    });
    expect(evidence).toContain(
      "Worker configuration is invalid: BETTER_AUTH_SECRET must contain at least 32 characters",
    );
    expect(evidence).not.toContain(secret);
  });

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

  it.effect("does not share Worker runtimes between concurrent requests", () =>
    Effect.gen(function* () {
      const responses = yield* Effect.promise(() =>
        Promise.all([
          exports.default.fetch(new Request("https://osfo.test/health")),
          exports.default.fetch(new Request("https://osfo.test/health")),
        ]),
      );
      const probes = yield* Effect.forEach(responses, decodeRuntimeProbe);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(probes[0]?.activationId).not.toBe(probes[1]?.activationId);
    }),
  );

  it("logs and throws safe configuration failures for scheduled work", () => {
    const secret = "bad";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      worker.scheduled(
        createScheduledController(),
        { ...env, BETTER_AUTH_SECRET: secret },
        createExecutionContext(),
      ),
    ).toThrowError(
      "Worker configuration is invalid: BETTER_AUTH_SECRET must contain at least 32 characters",
    );
    const evidence = error.mock.calls.flat().join(" ");
    error.mockRestore();

    expect(evidence).toContain(
      "Worker configuration is invalid: BETTER_AUTH_SECRET must contain at least 32 characters",
    );
    expect(evidence).not.toContain(secret);
  });

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
          "/v1/billing": { get: { operationId: "billing.inspect" } },
          "/v1/billing/checkout": {
            post: { operationId: "billing.checkout" },
          },
          "/v1/billing/portal": {
            post: { operationId: "billing.portal" },
          },
          "/v1/billing/reconcile": {
            post: { operationId: "billing.reconcile" },
          },
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

  it.effect("rejects an invalid Stripe signature before persistence", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        exports.default.fetch(
          new Request("https://osfo.test/v1/webhooks/stripe", {
            body: '{"id":"evt_invalid"}',
            headers: { "stripe-signature": "invalid" },
            method: "POST",
          }),
        ),
      );

      expect(response.status).toBe(400);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        message: "Invalid Stripe signature",
      });
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
});

const decodeRuntimeProbe = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(RuntimeProbe)(body)),
  );
