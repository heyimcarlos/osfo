import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

/** Server-owned immutable presentation for one permanent account-deletion Action. */
export const AccountDeletionActionPresentation = Schema.Struct({
  actionId: Schema.String,
  confirmation: Schema.Literal("delete-my-account"),
  consequence: Schema.Literal("Permanently delete this account and all of its data"),
  operation: Schema.Literal("account.delete"),
  title: Schema.Literal("Delete account"),
});

/** Server-owned immutable presentation for one permanent account-deletion Action. */
export type AccountDeletionActionPresentation = typeof AccountDeletionActionPresentation.Type;

/** Exact caller decision over the last server-owned account-deletion presentation. */
export const AccountDeletionRequest = Schema.Struct({
  approval: Schema.Struct({
    decision: Schema.Literal("approved"),
    presentation: AccountDeletionActionPresentation,
  }),
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
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Fence normal access and permanently delete the authenticated account.",
          identifier: "account.delete",
          summary: "Delete account",
        }),
      ),
  );
