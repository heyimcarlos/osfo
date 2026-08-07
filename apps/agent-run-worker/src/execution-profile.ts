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

export const liveOpenAIExecutionProfile = frozen({
  type: "openaiResponses" as const,
  ref: "oz.openai.gpt-4.1-mini-2025-04-14.responses.v1",
  modelBinding: "openai.responses.gpt-4.1-mini-2025-04-14.v1",
  model: "gpt-4.1-mini-2025-04-14",
  requiredSemantics: frozen({
    output: "text" as const,
    protocol: "responsesSseV1" as const,
    terminalEvent: "response.completed" as const,
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
    maxOutputTokens: 1_024,
    store: false,
    stream: true,
  }),
});

export type OzExecutionProfile =
  | typeof deterministicExecutionProfile
  | typeof liveOpenAIExecutionProfile;

export const resolveExecutionProfile = (ref: string): OzExecutionProfile | undefined => {
  switch (ref) {
    case deterministicExecutionProfile.ref:
      return deterministicExecutionProfile;
    case liveOpenAIExecutionProfile.ref:
      return liveOpenAIExecutionProfile;
    default:
      return undefined;
  }
};
