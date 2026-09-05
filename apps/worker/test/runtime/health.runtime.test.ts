import { expect, it } from "@effect/vitest";
import { SELF } from "cloudflare:test";
import { HealthResponse } from "@osfo/api";
import { Effect, Schema } from "effect";

// oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned to it.effect.
it.effect("preserves the health contract with a distinct identity for each Worker request", () =>
  Effect.gen(function* () {
    const first = yield* Effect.promise(() => SELF.fetch("https://osfo.test/health"));
    const second = yield* Effect.promise(() => SELF.fetch("https://osfo.test/health"));
    const decode = Schema.decodeUnknownEffect(HealthResponse);
    const firstHealth = yield* Effect.promise(() => first.json()).pipe(Effect.flatMap(decode));
    const secondHealth = yield* Effect.promise(() => second.json()).pipe(Effect.flatMap(decode));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstHealth).toMatchObject({
      executionUnit: "worker",
      identity: "request",
      kind: "RuntimeProbe",
      stage: "test",
    });
    expect(firstHealth.activationId).not.toBe("");
    expect(secondHealth.activationId).not.toBe(firstHealth.activationId);
    expect(secondHealth.stage).toBe(firstHealth.stage);
  }),
);
