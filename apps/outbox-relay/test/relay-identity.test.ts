import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { makeRelayIdConfig } from "../src/relay-identity.js";

const parseRelayId = (environment: Readonly<Record<string, string>>) =>
  Effect.runSync(
    makeRelayIdConfig("outbox-relay-test-id").parse(ConfigProvider.fromUnknown(environment)),
  );

describe("outbox relay identity", () => {
  it("prefers the explicit relay ID over the hostname", () => {
    expect(
      parseRelayId({
        HOSTNAME: "worker-pool-host",
        OSFO_RELAY_ID: "configured-relay",
      }),
    ).toBe("configured-relay");
  });

  it("uses the hostname when no explicit relay ID is configured", () => {
    expect(parseRelayId({ HOSTNAME: "worker-pool-host" })).toBe("worker-pool-host");
  });

  it("uses the process-unique fallback when neither identity is available", () => {
    expect(parseRelayId({})).toBe("outbox-relay-test-id");
  });
});
