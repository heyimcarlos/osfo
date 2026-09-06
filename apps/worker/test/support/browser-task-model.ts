/* oxlint-disable eslint/no-underscore-dangle -- Browser outcomes use canonical wire discriminators. */
/* oxlint-disable effecttsgo/node-builtin-import, osfo/no-runtime-typeof, osfo/no-unknown-parameters -- This local provider boundary derives selections solely from the current request and decoded tool results. */
import { createHash } from "node:crypto";
import { BrowserObservation, BrowserOutcome } from "@osfo/api/browser-host";
import { Option, Schema } from "effect";
import type { JsonObject, ResearchRequest } from "../emulators/provider-emulator";

const Task = Schema.Struct({
  taskId: Schema.String,
  requestText: Schema.String,
  closed: Schema.Boolean,
  observation: Schema.NullOr(BrowserObservation),
  lastOutcome: Schema.NullOr(BrowserOutcome),
  uncertainOperationId: Schema.NullOr(Schema.String),
});
const Listed = Schema.Array(
  Schema.Struct({
    taskId: Schema.String,
    requestText: Schema.String,
    observation: Schema.NullOr(Schema.Struct({ observationId: Schema.String })),
    lastOperationId: Schema.String,
  }),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Synthetic model behavior uses actual page evidence, never a stored or canned booking result. */
export const respondBrowserTask = (input: ResearchRequest) => {
  const messages = input.messages ?? [];
  const currentIndex = messages.reduce(
    (found, message, index) =>
      message.role === "user" &&
      !text(message.content).startsWith(
        "Continue your previous response from exactly where it left off.",
      )
        ? index
        : found,
    -1,
  );
  const instruction = text(messages[currentIndex]?.content).trimEnd().split(/\r?\n/u).at(-1) ?? "";
  if (!/synthetic browser (?:appointment|task)/iu.test(instruction)) return null;
  const tools = input.tools?.flatMap((tool) => tool.function?.name ?? []) ?? [];
  const select = (name: string, arguments_: JsonObject) => {
    if (!tools.includes(name))
      throw new Error(`Browser verification requires the admitted ${name} tool`);
    const digest = createHash("sha256").update(encode(input)).digest("hex").slice(0, 20);
    return {
      finish_reason: "tool_calls" as const,
      response: "",
      tool_calls: [
        {
          name,
          arguments: arguments_,
          id: `verification-browser-${name}-${digest}`,
        },
      ],
      usage: { completion_tokens: 1, prompt_tokens: 1 },
    };
  };
  const turnTools = messages.slice(currentIndex + 1).filter((message) => message.role === "tool");
  const last = turnTools.at(-1);
  const closing = /close.*synthetic browser task/iu.test(instruction);
  const inspecting = /inspect.*synthetic browser task/iu.test(instruction);
  if (last === undefined) {
    const url = /http:\/\/127\.0\.0\.1:39271\/book\b/u.exec(instruction)?.[0];
    return url === undefined ? select("listBrowserTasks", {}) : select("openBrowserTask", { url });
  }
  if (last.name === "listBrowserTasks") {
    const listed = Schema.decodeUnknownSync(Listed)(value(last.content));
    if (listed.length !== 1)
      return stop("A single owned task was not established. No browser effect was requested.");
    const task = listed[0];
    if (task === undefined) return stop("No owned browser task was returned.");
    if (closing) return select("closeBrowserTask", { taskId: task.taskId });
    if (inspecting)
      return select("inspectBrowserOutcome", {
        taskId: task.taskId,
        operationId: task.observation?.observationId ?? task.lastOperationId,
      });
    return select("observeBrowserTask", { taskId: task.taskId });
  }
  if (last.name === "executeBrowserEffect") {
    const rejected = Schema.decodeUnknownOption(
      Schema.Struct({ status: Schema.Literal("rejected"), executionId: Schema.String }),
    )(value(last.content));
    if (Option.isSome(rejected)) return stop("You rejected this browser action. It has not run.");
    const paused = Schema.decodeUnknownOption(
      Schema.Struct({
        status: Schema.Literal("paused"),
        action: Schema.Literal("executeBrowserEffect"),
        executionId: Schema.String,
      }),
    )(value(last.content));
    if (Option.isSome(paused))
      return stop(
        "The browser interaction is waiting for your decision on the browser review page. It has not run.",
      );
  }
  const decoded = Schema.decodeUnknownOption(Task)(value(last.content));
  if (Option.isNone(decoded))
    return stop(
      "The browser operation returned no usable owned evidence. No further effect was requested.",
    );
  const task = decoded.value;
  if (closing)
    return stop(
      task.closed && task.lastOutcome?._tag === "Closed"
        ? "The owned browser task is closed."
        : "Owned tab cleanup is not confirmed.",
    );
  if (task.uncertainOperationId !== null || task.lastOutcome?._tag !== "Observed")
    return stop("The browser outcome is unresolved. It has not been retried.");
  const observation = task.observation;
  if (
    observation === null ||
    task.lastOutcome.observation.observationId !== observation.observationId ||
    observation.taskId !== task.taskId ||
    observation.url !== "http://127.0.0.1:39271/book"
  )
    return stop("No matching owned portal observation was returned.");
  if (inspecting || observation.text.includes("Confirmed. Receipt "))
    return stop(`Retained request: ${task.requestText}\nObserved page: ${observation.text}`);
  if (!task.requestText.includes("Prefer Tuesday morning"))
    return stop("The returned task does not establish the fixture's Tuesday preference.");
  const selected = observation.text.includes("Selected: Tuesday at 10:00 AM");
  const label = selected ? "Confirm synthetic appointment" : "Choose Tuesday at 10:00 AM";
  const lines = observation.text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) => /^\d+ button\b/u.test(line) && line.includes(label) && !/disabled/iu.test(line),
    );
  if (lines.length !== 1 || lines[0] === undefined)
    return stop("The fresh page has no single enabled target. Confirmation is not established.");
  const targetDescription = lines[0];
  const target = /^\d+/u.exec(targetDescription)?.[0];
  if (target === undefined) return stop("The observation has no target index.");
  return select("executeBrowserEffect", {
    taskId: task.taskId,
    observationId: observation.observationId,
    expectedUrl: observation.url,
    targetDescription,
    interaction: { _tag: "Click", target },
    consequence: selected
      ? `Confirm the selected synthetic appointment shown on this page: ${label}.`
      : `Select the observed option ${label}; this does not confirm an appointment.`,
  });
};

const stop = (response: string) => ({
  finish_reason: "stop" as const,
  response,
  usage: { completion_tokens: 1, prompt_tokens: 1 },
});
const text = (content: unknown) => (typeof content === "string" ? content : "");
const value = (content: unknown) =>
  typeof content === "string"
    ? Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(content)
    : content;
