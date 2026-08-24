import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

/** Exact settings confirmation accepted for permanent account deletion. */
export const AccountDeletionRequest = Schema.Struct({
  confirmation: Schema.Literal("delete-my-account"),
});

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
export const AccountGroup = HttpApiGroup.make("account").add(
  HttpApiEndpoint.delete("deleteAccount", "/v1/account", {
    error: AccountDeletionUnavailable,
    payload: AccountDeletionRequest,
    success: AccountDeletionResponse,
  })
    .middleware(Auth)
    .annotateMerge(
      OpenApi.annotations({
        description: "Fence normal access and permanently delete the authenticated account.",
        identifier: "account.delete",
        summary: "Delete account",
      }),
    ),
);
