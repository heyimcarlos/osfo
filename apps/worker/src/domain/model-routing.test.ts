import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { ModelAccessPolicyVersion } from "../domain";
import {
  chooseRouteProfile,
  currentModelRoutingPolicy,
  handleStrongerRouteOutage,
  routeAfterAttempt,
} from "./model-routing";

/* oxlint-disable eslint/no-underscore-dangle -- Routing failures use the standard Effect _tag discriminator. */

describe("managed model routing policy", () => {
  it("chooses all four profiles deterministically without trusting task adjectives", () => {
    const routine = requirements();
    expect(chooseRouteProfile("free", routine, false)).toBe("freeNormal");
    expect(chooseRouteProfile("adventurer", routine, false)).toBe("adventurerRoutine");
    expect(
      chooseRouteProfile("adventurer", { ...routine, workflowQuality: "frontier" }, false),
    ).toBe("adventurerFrontier");
    expect(chooseRouteProfile("adventurer", routine, true)).toBe("exhaustedConversation");
    expect(
      chooseRouteProfile("adventurer", { ...routine, userDescription: "best and hard" }, false),
    ).toBe("adventurerRoutine");
  });

  it("allows one evidence-based upward escalation and never oscillates", () => {
    const escalated = routeAfterAttempt({
      escalationCount: 0,
      profile: "adventurerRoutine",
      reason: "verifierRejected",
    });
    expect(Result.getOrThrow(escalated)).toEqual({
      escalationCount: 1,
      profile: "adventurerFrontier",
    });
    const secondEscalation = routeAfterAttempt({
      escalationCount: 1,
      profile: "adventurerFrontier",
      reason: "verifierRejected",
    });
    expect(Result.isFailure(secondEscalation)).toBe(true);
    if (Result.isSuccess(secondEscalation)) return;
    expect(secondEscalation.failure._tag).toBe("RoutingDecisionDenied");

    const providerFallback = routeAfterAttempt({
      escalationCount: 0,
      profile: "adventurerRoutine",
      reason: "providerFallback",
    });
    expect(Result.isFailure(providerFallback)).toBe(true);
    if (Result.isSuccess(providerFallback)) return;
    expect(providerFallback.failure._tag).toBe("RoutingDecisionDenied");
  });

  it("keeps equivalent fallback in profile and pauses an unqualified downgrade", () => {
    expect(currentModelRoutingPolicy.equivalentFallbackCandidatesPerStep).toBe(1);
    expect(currentModelRoutingPolicy.sameModelRetries).toBe(0);
    expect(
      handleStrongerRouteOutage("adventurerFrontier", { lowerProfileQualified: true }),
    ).toEqual({ _tag: "UseLowerProfile", profile: "adventurerRoutine" });
    expect(
      handleStrongerRouteOutage("adventurerFrontier", { lowerProfileQualified: false }),
    ).toEqual({ _tag: "Pause", reason: "strongerRouteUnavailable" });
  });

  it("retains direct routing until every Dynamic Routing proof is present", () => {
    expect(currentModelRoutingPolicy.version).toBe(
      ModelAccessPolicyVersion.make("managed-routing-v1"),
    );
    expect(currentModelRoutingPolicy.activation.status).toBe("MISSING");
    expect(currentModelRoutingPolicy.executionPlane).toBe("directWorkersAi");
    expect(Object.values(currentModelRoutingPolicy.activation.proof).every(Boolean)).toBe(false);
  });
});

const requirements = () => ({
  inputTokens: 8_000,
  modality: "text" as const,
  outputTokens: 1_000,
  stepBudget: 2,
  structuredOutput: false,
  toolUse: false,
  userDescription: null,
  verifier: "none" as const,
  workflowQuality: "routine" as const,
});
