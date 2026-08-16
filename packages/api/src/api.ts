import { HttpApi, OpenApi } from "effect/unstable/httpapi";

import { HealthGroup } from "./groups/health";
import { RegistrationGroup } from "./groups/registration";

/** Shared HTTP contract implemented by the Worker and consumed by clients. */
export const Api = HttpApi.make("osfo")
  .add(HealthGroup)
  .add(RegistrationGroup)
  .annotateMerge(
    OpenApi.annotations({
      description: "Osfo control-plane HTTP API.",
      title: "Osfo API",
      version: "0.1.0",
    }),
  );

export { HealthGroup, HealthResponse } from "./groups/health";
export {
  AgentId,
  RegistrationGroup,
  RegistrationResponse,
  RegistrationUnavailable,
  UserId,
} from "./groups/registration";
export {
  Auth,
  AuthenticationUnavailable,
  CurrentUser,
  Unauthorized,
  type CurrentUserValue,
} from "./middleware/auth";
