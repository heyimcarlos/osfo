import type { ContextOverflowConfig } from "@cloudflare/think";

export interface ContextOverflowPolicyInput {
  readonly contextWindowTokens: number;
  readonly proactiveCompactionLimit: number;
  readonly reactiveRetryLimit: number;
  readonly targetInputTokens: number;
}

/** Translate one model's configured target into Think's bounded compaction safeguards. */
export const contextOverflowPolicy = (
  input: ContextOverflowPolicyInput,
): ContextOverflowConfig => ({
  maxRetries: input.reactiveRetryLimit,
  proactive: {
    headroom: input.targetInputTokens / input.contextWindowTokens,
    maxCompactions: input.proactiveCompactionLimit,
    maxInputTokens: input.contextWindowTokens,
  },
  reactive: true,
});
