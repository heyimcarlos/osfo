import type { PendingApproval } from "@cloudflare/think";
import { Effect, Option, Schema } from "effect";

const BrowserPause = Schema.Struct({
  status: Schema.Literal("paused"),
  action: Schema.Literal("executeBrowserEffect"),
  executionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

class BrowserApprovalReplyUnavailable extends Schema.TaggedError<BrowserApprovalReplyUnavailable>()(
  "BrowserApprovalReplyUnavailable",
  { message: Schema.String },
) {}

/** Add the review link to the authorized messenger reply only while its committed pause remains pending. */
export const appendBrowserApprovalLink = Effect.fn("BrowserApproval.reply")(function* (options: {
  readonly parts: ReadonlyArray<unknown>;
  readonly text: string;
  readonly webBaseUrl: URL;
  readonly pending: (executionId: string) => Promise<Array<PendingApproval>>;
}) {
  const identities = options.parts.flatMap((part) => {
    const paused = Schema.decodeUnknownOption(PausedBrowserPart)(part);
    return Option.isSome(paused) ? [paused.value.output.executionId] : [];
  });
  const pending = yield* Effect.forEach([...new Set(identities)], (executionId) =>
    Effect.tryPromise({
      try: () => options.pending(executionId),
      catch: () =>
        new BrowserApprovalReplyUnavailable({ message: "Browser approval state is unavailable." }),
    }).pipe(
      Effect.map((items) =>
        items.some(
          (item) =>
            item.executionId === executionId &&
            item.source === "action" &&
            item.descriptor.action === "executeBrowserEffect",
        ),
      ),
    ),
  );
  if (!pending.some(Boolean)) return options.text;
  const url = new URL("/settings/browser", options.webBaseUrl).href;
  return `${options.text}\n\nI’m ready to take the next step in the browser. Review and approve it here: ${url}\nThis step has not run yet.`;
});

const PausedBrowserPart = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool-executeBrowserEffect"),
    state: Schema.Literal("output-available"),
    output: BrowserPause,
  }),
  Schema.Struct({
    type: Schema.Literal("dynamic-tool"),
    toolName: Schema.Literal("executeBrowserEffect"),
    state: Schema.Literal("output-available"),
    output: BrowserPause,
  }),
]);
