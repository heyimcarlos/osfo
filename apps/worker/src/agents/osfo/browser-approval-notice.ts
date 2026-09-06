import type { PendingApproval, StepContext } from "@cloudflare/think";
import { Effect, Option, Schema } from "effect";

const BrowserPause = Schema.Struct({
  status: Schema.Literal("paused"),
  action: Schema.Literal("executeBrowserEffect"),
  executionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

class BrowserApprovalNoticeUnavailable extends Schema.TaggedError<BrowserApprovalNoticeUnavailable>()(
  "BrowserApprovalNoticeUnavailable",
  { message: Schema.String },
) {}

/** Native pause evidence and the current pending ledger must agree before sending a review link. */
export const notifyBrowserApproval = Effect.fn("BrowserApproval.notify")(function* (options: {
  readonly results: StepContext["toolResults"];
  readonly webBaseUrl: URL;
  readonly pending: (executionId: string) => Promise<Array<PendingApproval>>;
  readonly deliver: (text: string) => Promise<void>;
}) {
  const identities = options.results.flatMap((result) => {
    if (result.toolName !== "executeBrowserEffect") return [];
    const paused = Schema.decodeUnknownOption(BrowserPause)(result.output);
    return Option.isSome(paused) ? [paused.value.executionId] : [];
  });
  yield* Effect.forEach([...new Set(identities)], (executionId) =>
    Effect.gen(function* () {
      const pending = yield* Effect.tryPromise({
        try: () => options.pending(executionId),
        catch: () =>
          new BrowserApprovalNoticeUnavailable({
            message: "Browser approval state is unavailable.",
          }),
      });
      if (
        !pending.some(
          (item) =>
            item.executionId === executionId &&
            item.source === "action" &&
            item.descriptor.action === "executeBrowserEffect",
        )
      )
        return;
      const url = new URL("/settings/browser", options.webBaseUrl).href;
      yield* Effect.tryPromise({
        try: () =>
          options.deliver(
            `I’m ready to take the next step in the browser. Review and approve it here: ${url}\nThis step has not run yet.`,
          ),
        catch: () =>
          new BrowserApprovalNoticeUnavailable({
            message: "The browser approval review link could not be delivered.",
          }),
      });
    }),
  );
});
