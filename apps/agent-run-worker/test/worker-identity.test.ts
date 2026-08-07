import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { makeAgentRunWorkerIdConfig } from "../src/worker-identity.js";

const parseWorkerId = (environment: Readonly<Record<string, string>>) =>
  Effect.runSync(
    makeAgentRunWorkerIdConfig("agent-run-worker-test-id").parse(
      ConfigProvider.fromUnknown(environment),
    ),
  );

describe("AgentRun worker identity", () => {
  it("prefers the explicit worker ID over the hostname", () => {
    expect(
      parseWorkerId({
        HOSTNAME: "worker-pool-host",
        OSFO_AGENT_RUN_WORKER_ID: "configured-worker",
      }),
    ).toBe("configured-worker");
  });

  it("uses the hostname when no explicit worker ID is configured", () => {
    expect(parseWorkerId({ HOSTNAME: "worker-pool-host" })).toBe("worker-pool-host");
  });

  it("uses the process-unique fallback when neither identity is available", () => {
    expect(parseWorkerId({})).toBe("agent-run-worker-test-id");
  });
});
