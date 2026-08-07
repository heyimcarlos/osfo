const frozen = <A extends object>(value: A): Readonly<A> => Object.freeze(value);

export const deterministicExecutionProfile = frozen({
  type: "deterministic" as const,
  ref: "oz.deterministic.v1",
  modelBinding: "oz.deterministic.echo.v1",
  retry: frozen({
    automaticProviderRetries: 0,
    modelCallAttempts: 2,
  }),
});

export const liveOpenRouterExecutionProfile = frozen({
  type: "openRouterChatCompletions" as const,
  ref: "oz.openrouter.minimax.minimax-m3.chat-completions.v1",
  modelBinding: "openrouter.chat-completions.minimax.minimax-m3.v1",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  model: "minimax/minimax-m3",
  provider: "Minimax",
  requiredSemantics: frozen({
    output: "text" as const,
    protocol: "chatCompletionsSseV1" as const,
    terminalEnvelope: "[DONE]" as const,
    finishReason: "stop" as const,
  }),
  permittedAdaptations: frozen({
    coalesceUpToDeltas: 8,
  }),
  deadlines: frozen({
    responseHeadersMs: 10_000,
    responseStreamMs: 120_000,
  }),
  retry: frozen({
    automaticProviderRetries: 0,
    modelCallAttempts: 1,
  }),
  request: frozen({
    maxTokens: 1_024,
    temperature: 0,
    stream: true,
    reasoning: frozen({
      enabled: true,
      exclude: true,
    }),
    provider: frozen({
      only: frozen(["minimax"] as const),
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: "deny" as const,
    }),
  }),
});

export type OzExecutionProfile =
  | typeof deterministicExecutionProfile
  | typeof liveOpenRouterExecutionProfile;

export const resolveExecutionProfile = (ref: string): OzExecutionProfile | undefined => {
  switch (ref) {
    case deterministicExecutionProfile.ref:
      return deterministicExecutionProfile;
    case liveOpenRouterExecutionProfile.ref:
      return liveOpenRouterExecutionProfile;
    default:
      return undefined;
  }
};
