import {
  InvalidRunnableDelivery,
  RunnableAgentRunDeliverySchema,
  decodeRunnableDeliveryData,
  encodeRunnableDeliveryData,
  type RunnableAgentRunDelivery,
} from "@osfo/agent-run";
import type { Effect } from "effect";
import { describe, expect, it } from "tstyche";

const delivery = {
  version: 1,
  deliveryId: "019c9f26-aab5-7000-8000-000000000001",
  agentRunId: "019c9f26-aab5-7000-8000-000000000002",
  threadId: "019c9f26-aab5-7000-8000-000000000003",
  executionProfileRef: "default",
} as const;

describe("runnable delivery public type contract", () => {
  it("infers the exported delivery shape", () => {
    expect(delivery).type.toBeAssignableTo<RunnableAgentRunDelivery>();
    expect<RunnableAgentRunDelivery["version"]>().type.toBe<1>();
  });

  it("preserves decoder success, error, and requirement channels", () => {
    const decoded = decodeRunnableDeliveryData(new Uint8Array());

    expect<Effect.Success<typeof decoded>>().type.toBe<RunnableAgentRunDelivery>();
    expect<Effect.Error<typeof decoded>>().type.toBe<InvalidRunnableDelivery>();
    expect<Effect.Services<typeof decoded>>().type.toBe<never>();
  });

  it("preserves Schema constructor overloads", () => {
    expect(RunnableAgentRunDeliverySchema.make).type.toBeCallableWith(delivery);
    expect(RunnableAgentRunDeliverySchema.make).type.toBeCallableWith(delivery, {
      disableChecks: true,
    });
  });

  it("rejects forbidden public calls", () => {
    expect(encodeRunnableDeliveryData).type.not.toBeCallableWith({
      ...delivery,
      version: 2,
    });
    expect(RunnableAgentRunDeliverySchema.make).type.not.toBeCallableWith({
      ...delivery,
      executionProfileRef: 1,
    });
  });
});
