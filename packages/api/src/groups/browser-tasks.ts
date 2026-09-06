import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

const taskId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const url = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

export const BrowserTaskSummary = Schema.Struct({
  taskId,
  url,
  state: Schema.Literals(["active", "human"]),
});
export type BrowserTaskSummary = typeof BrowserTaskSummary.Type;

export const BrowserTasks = Schema.Struct({ items: Schema.Array(BrowserTaskSummary) });
export const BrowserTaskSelection = Schema.Struct({ taskId });
export type BrowserTaskSelection = typeof BrowserTaskSelection.Type;

export const BrowserTaskLiveView = Schema.Struct({
  taskId,
  url: url.check(Schema.isPattern(/^https:\/\//)),
  expiresInMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3_600_000)),
});
export type BrowserTaskLiveView = typeof BrowserTaskLiveView.Type;

export const BrowserTaskResumed = Schema.Struct({ taskId, state: Schema.Literal("active") });

export class BrowserTasksUnavailable extends Schema.TaggedError<BrowserTasksUnavailable>()(
  "BrowserTasksUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export const BrowserTasksGroup = HttpApiGroup.make("browserTasks")
  .add(
    HttpApiEndpoint.get("list", "/v1/browser/tasks", {
      error: BrowserTasksUnavailable,
      success: BrowserTasks,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Inspect your browser tasks" })),
  )
  .add(
    HttpApiEndpoint.post("open", "/v1/browser/tasks/open", {
      error: BrowserTasksUnavailable,
      payload: BrowserTaskSelection,
      success: BrowserTaskLiveView,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({ summary: "Pause a browser task and open human control" }),
      ),
  )
  .add(
    HttpApiEndpoint.post("resume", "/v1/browser/tasks/resume", {
      error: BrowserTasksUnavailable,
      payload: BrowserTaskSelection,
      success: BrowserTaskResumed,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Return a browser task to Osfo" })),
  );
