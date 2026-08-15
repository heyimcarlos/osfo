import { HttpApi, OpenApi } from "effect/unstable/httpapi";

import { HealthGroup } from "./groups/health";

/** Shared HTTP contract implemented by the Worker and consumed by clients. */
export const Api = HttpApi.make("osfo")
  .add(HealthGroup)
  .annotateMerge(
    OpenApi.annotations({
      description: "Osfo control-plane HTTP API.",
      title: "Osfo API",
      version: "0.1.0",
    }),
  );

export { HealthGroup, HealthResponse } from "./groups/health";
export { Auth, CurrentUser, Unauthorized, type CurrentUserValue } from "./middleware/auth";
