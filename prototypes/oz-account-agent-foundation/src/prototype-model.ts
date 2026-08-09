import type { LanguageModel } from "ai";

const finishReason = { raw: undefined, unified: "stop" as const };
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 8, total: 8 },
  outputTokens: { reasoning: 0, text: 6, total: 6 },
};

const markerDelay = (options: Record<string, unknown>): number => {
  const prompt = JSON.stringify(options.prompt ?? []);
  if (prompt.includes("[recover]")) return 3_000;
  if (prompt.includes("[slow]")) return 15_000;
  return 0;
};

const waitUntilElapsedOrAborted = (milliseconds: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export const makePrototypeModel = (): LanguageModel => ({
  async doGenerate() {
    return {
      content: [{ text: "Oz prototype response", type: "text" as const }],
      finishReason,
      usage,
      warnings: [],
    };
  },
  doStream(options: Record<string, unknown>) {
    const delay = markerDelay(options);
    const slow = delay > 0;
    const signal = (options as { readonly abortSignal?: AbortSignal }).abortSignal;
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ id: "prototype-text", type: "text-start" });
        controller.enqueue({
          delta: slow ? "Partial response before interruption. " : "Oz prototype response.",
          id: "prototype-text",
          type: "text-delta",
        });
        if (slow) {
          await waitUntilElapsedOrAborted(delay, signal);
          if (signal?.aborted) {
            controller.close();
            return;
          }
          controller.enqueue({
            delta: "Recovered completion.",
            id: "prototype-text",
            type: "text-delta",
          });
        }
        controller.enqueue({ id: "prototype-text", type: "text-end" });
        controller.enqueue({ finishReason, type: "finish", usage });
        controller.close();
      },
    });
    return Promise.resolve({ stream });
  },
  modelId: "oz-foundation-prototype",
  provider: "prototype",
  specificationVersion: "v3",
  supportedUrls: {},
});
