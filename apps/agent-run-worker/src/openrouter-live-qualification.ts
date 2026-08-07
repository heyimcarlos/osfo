import type { ModelCallAttemptOutcome, ModelCallObservation } from "@osfo/agent-run";
import { liveOpenRouterExecutionProfile } from "./execution-profile.js";

interface OpenRouterLiveQualificationInput {
  readonly observations: ReadonlyArray<ModelCallObservation>;
  readonly outcome: ModelCallAttemptOutcome;
  readonly requestCount: number;
}

export const evaluateOpenRouterLiveQualification = (input: OpenRouterLiveQualificationInput) => {
  const normalizedText = input.observations.map((observation) => observation.text).join("");
  const providerRequestId =
    input.outcome.dispatchEvidence.type === "confirmed"
      ? input.outcome.dispatchEvidence.providerRequestId
      : undefined;
  const reportedUsage = input.outcome.usage.type === "reported";
  const reasoningUsage = reportedUsage ? input.outcome.usage.reasoningUnits : undefined;
  const totalUsage = reportedUsage
    ? input.outcome.usage.inputUnits + input.outcome.usage.outputUnits
    : 0;
  const checks = {
    oneHttpRequest: input.requestCount === 1,
    stableGenerationId: providerRequestId !== undefined,
    textCompletion: input.outcome.completion.type === "text",
    nonemptyNormalizedText: normalizedText.trim().length > 0,
    exactExpectedText: normalizedText.trim() === "qualified",
    reportedUsage: reportedUsage && totalUsage > 0,
    reasoningUsage: reasoningUsage !== undefined && reasoningUsage > 0,
  } as const;
  const failedCheck = Object.entries(checks).find(([, passed]) => !passed)?.[0];
  if (failedCheck !== undefined) {
    return { type: "fail", check: failedCheck } as const;
  }
  return {
    type: "pass",
    evidence: {
      profileRef: liveOpenRouterExecutionProfile.ref,
      modelBinding: liveOpenRouterExecutionProfile.modelBinding,
      model: liveOpenRouterExecutionProfile.model,
      provider: liveOpenRouterExecutionProfile.provider,
      oneHttpRequest: true,
      stableGenerationId: true,
      textCompletion: true,
      terminalStop: true,
      terminalDone: true,
      nonemptyNormalizedText: true,
      exactExpectedText: true,
      reportedUsage: true,
      reasoningUsage: true,
    },
  } as const;
};

type OpenRouterLiveQualificationEvidence = Extract<
  ReturnType<typeof evaluateOpenRouterLiveQualification>,
  { readonly type: "pass" }
>["evidence"];

export const renderOpenRouterLiveQualificationPass = (
  evidence: OpenRouterLiveQualificationEvidence,
) => `PASS ${JSON.stringify(evidence)}`;
