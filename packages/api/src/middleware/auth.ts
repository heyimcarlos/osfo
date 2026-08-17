import { Context, Schema } from "effect";
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi";

/** Authenticated User available to protected API handlers. */
export interface CurrentUserValue {
  readonly authSessionId: string;
  readonly authSessionExpiresAt: Date;
  readonly userId: string;
}

/** Authenticated User available to protected API handlers. */
export class CurrentUser extends Context.Service<CurrentUser, CurrentUserValue>()(
  "@osfo/api/CurrentUser",
) {}

/** Safe response when a request has no valid Better Auth session. */
export const Unauthorized = HttpApiError.Unauthorized;

/** Safe response when the authentication authority is unavailable. */
export class AuthenticationUnavailable extends Schema.TaggedError<AuthenticationUnavailable>()(
  "AuthenticationUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Authentication requirement for protected API groups. */
export class Auth extends HttpApiMiddleware.Service<Auth, { readonly provides: CurrentUser }>()(
  "@osfo/api/Auth",
  { error: [Unauthorized, AuthenticationUnavailable] },
) {}
