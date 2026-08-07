import { describe, expect, it } from "@effect/vitest";
import {
  evaluateOpenRouterLiveQualification,
  renderOpenRouterLiveQualificationPass,
} from "../src/openrouter-live-qualification.js";

const reportedOutcome = {
  dispatchEvidence: {
    type: "confirmed" as const,
    providerRequestId: "secret-generation-id",
  },
  usage: {
    type: "reported" as const,
    inputUnits: 4,
    outputUnits: 5,
    reasoningUnits: 7,
  },
  completion: { type: "text" as const },
};

describe("OpenRouter live qualification reporting", () => {
  it("accepts the exact trimmed expected text and renders only sanitized evidence", () => {
    const evaluation = evaluateOpenRouterLiveQualification({
      observations: [{ fragmentIndex: 0, text: "qualified\n" }],
      outcome: reportedOutcome,
      requestCount: 1,
    });

    expect(evaluation.type).toBe("pass");
    if (evaluation.type === "pass") {
      expect(evaluation.evidence.exactExpectedText).toBe(true);
      const report = renderOpenRouterLiveQualificationPass(evaluation.evidence);
      expect(report).toContain("PASS ");
      expect(report).toContain('"exactExpectedText":true');
      expect(report).not.toContain("secret-generation-id");
      expect(report).not.toContain('"qualified"');
    }
  });

  it("rejects nonempty normalized text that does not match the fixed expectation", () => {
    const evaluation = evaluateOpenRouterLiveQualification({
      observations: [{ fragmentIndex: 0, text: "not-qualified" }],
      outcome: reportedOutcome,
      requestCount: 1,
    });

    expect(evaluation).toEqual({ type: "fail", check: "exactExpectedText" });
  });
});
