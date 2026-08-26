import { Context, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi";

import {
  AuthenticationUnavailable,
  Auth,
  type CurrentUserValue,
  Unauthorized,
} from "../middleware/auth";

/** Caller admitted either by a current session or one exact retained deletion replay. */
export type AccountDeletionCallerValue =
  | ({ readonly _tag: "CurrentUser" } & CurrentUserValue)
  | { readonly _tag: "RetainedReplay"; readonly userId: string };

/** Caller admitted either by a current session or one exact retained deletion replay. */
export class AccountDeletionCaller extends Context.Service<
  AccountDeletionCaller,
  AccountDeletionCallerValue
>()("@osfo/api/AccountDeletionCaller") {}

/** Narrow authorization required only by the destructive account endpoint. */
export class AccountDeletionAuth extends HttpApiMiddleware.Service<
  AccountDeletionAuth,
  { readonly provides: AccountDeletionCaller }
>()("@osfo/api/AccountDeletionAuth", { error: [Unauthorized, AuthenticationUnavailable] }) {}

const BoundedActionText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));

/** Bounded wire representation of a server-owned account-deletion Action. */
export const AccountDeletionActionPresentation = Schema.Struct({
  actionId: BoundedActionText,
  confirmation: BoundedActionText,
  consequence: BoundedActionText,
  operation: BoundedActionText,
  title: BoundedActionText,
});

/** Bounded wire representation of a server-owned account-deletion Action. */
export type AccountDeletionActionPresentation = typeof AccountDeletionActionPresentation.Type;

/** Exact caller decision over the last server-owned account-deletion presentation. */
export const AccountDeletionRequest = Schema.Struct({
  approval: Schema.Struct({
    decision: Schema.Literal("approved"),
    presentation: AccountDeletionActionPresentation,
  }),
  confirmation: BoundedActionText,
});
export type AccountDeletionRequest = typeof AccountDeletionRequest.Type;

/** Accepted account deletion that has already fenced normal access. */
export const AccountDeletionResponse = Schema.Struct({
  status: Schema.Literal("deletion-pending"),
});

/** Safe response while durable account deletion cannot be started. */
export class AccountDeletionUnavailable extends Schema.TaggedError<AccountDeletionUnavailable>()(
  "AccountDeletionUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Authenticated account lifecycle contract. */
export const AccountGroup = HttpApiGroup.make("account")
  .add(
    HttpApiEndpoint.get("presentAccountDeletion", "/v1/account/deletion-action", {
      error: AccountDeletionUnavailable,
      success: AccountDeletionActionPresentation,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Present the exact immutable Action that can delete this account.",
          identifier: "account.delete.present",
          summary: "Present account deletion",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("deleteAccount", "/v1/account", {
      error: AccountDeletionUnavailable,
      payload: AccountDeletionRequest,
      success: AccountDeletionResponse,
    })
      .middleware(AccountDeletionAuth)
      .annotateMerge(
        OpenApi.annotations({
          description:
            "Fence and delete an account from a current session, or resume one exact retained lost-response request after that session is revoked.",
          identifier: "account.delete",
          summary: "Delete Account",
        }),
      ),
  );
