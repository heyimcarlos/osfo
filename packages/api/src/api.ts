import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { ThreadsApi } from "./threads/api.js";

export const OsfoApi = HttpApi.make("osfo")
  .add(ThreadsApi)
  .annotateMerge(
    OpenApi.annotations({
      title: "Osfo API",
      description: "The typed HTTP interface for Osfo clients.",
    }),
  );
