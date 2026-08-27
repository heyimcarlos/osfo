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
  | {
      readonly _tag: "RetainedReplay";
      readonly deletionCaseId: string;
      readonly userId: string;
    };

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

/** Every presentation version that remains safe to submit or replay across a deployment rollover. */
export const accountDeletionPresentationDefinitions = {
  "account-deletion-v1": {
    confirmation: "delete-my-account",
    consequence: "Permanently delete this account and all of its data.",
    operation: "account.delete",
    title: "Delete Account",
  },
  "account-deletion-v2": {
    confirmation: "delete-my-account",
    consequence: "Permanently delete this account and all of its data.",
    operation: "account.delete",
    title: "Delete Account",
  },
} as const;

export const AccountDeletionPresentationVersion = Schema.Literals([
  "account-deletion-v1",
  "account-deletion-v2",
]);
export type AccountDeletionPresentationVersion = typeof AccountDeletionPresentationVersion.Type;

const presentationV1 = accountDeletionPresentationDefinitions["account-deletion-v1"];
const presentationV2 = accountDeletionPresentationDefinitions["account-deletion-v2"];

export const AccountDeletionActionPresentationV1 = Schema.Struct({
  actionId: BoundedActionText,
  confirmation: Schema.Literal(presentationV1.confirmation),
  consequence: Schema.Literal(presentationV1.consequence),
  operation: Schema.Literal(presentationV1.operation),
  title: Schema.Literal(presentationV1.title),
});
export const AccountDeletionActionPresentationV2 = Schema.Struct({
  actionId: BoundedActionText,
  confirmation: Schema.Literal(presentationV2.confirmation),
  consequence: Schema.Literal(presentationV2.consequence),
  operation: Schema.Literal(presentationV2.operation),
  title: Schema.Literal(presentationV2.title),
});

/** Exact supported wire representation of a server-owned account-deletion Action. */
export const AccountDeletionActionPresentation = Schema.Union([
  AccountDeletionActionPresentationV1,
  AccountDeletionActionPresentationV2,
]);

/** Exact supported wire representation of a server-owned account-deletion Action. */
export type AccountDeletionActionPresentation = typeof AccountDeletionActionPresentation.Type;

/** Opaque bearer retained only to resume the exact consumed deletion Action while its Case exists. */
export const AccountDeletionReplayToken = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u),
);
export type AccountDeletionReplayToken = typeof AccountDeletionReplayToken.Type;

const actionSchema = <
  const Version extends AccountDeletionPresentationVersion,
  const Presentation extends Schema.Top,
>(
  version: Version,
  presentation: Presentation,
) =>
  Schema.Struct({
    presentation,
    presentationVersion: Schema.Literal(version),
    replayToken: AccountDeletionReplayToken,
  });

const requestSchema = <
  const Version extends AccountDeletionPresentationVersion,
  const Presentation extends Schema.Top,
>(
  version: Version,
  presentation: Presentation,
  confirmation: (typeof accountDeletionPresentationDefinitions)[Version]["confirmation"],
) =>
  Schema.Struct({
    approval: Schema.Struct({
      decision: Schema.Literal("approved"),
      presentation,
    }),
    confirmation: Schema.Literal(confirmation),
    presentationVersion: Schema.Literal(version),
    replayToken: AccountDeletionReplayToken,
  });

/** Exact presented Action plus its opaque retained-replay bearer. */
export const AccountDeletionAction = Schema.Union([
  actionSchema("account-deletion-v1", AccountDeletionActionPresentationV1),
  actionSchema("account-deletion-v2", AccountDeletionActionPresentationV2),
]);
export type AccountDeletionAction = typeof AccountDeletionAction.Type;

/** Exact caller decision over the last server-owned account-deletion presentation. */
export const AccountDeletionRequest = Schema.Union([
  requestSchema(
    "account-deletion-v1",
    AccountDeletionActionPresentationV1,
    accountDeletionPresentationDefinitions["account-deletion-v1"].confirmation,
  ),
  requestSchema(
    "account-deletion-v2",
    AccountDeletionActionPresentationV2,
    accountDeletionPresentationDefinitions["account-deletion-v2"].confirmation,
  ),
]);
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
      success: AccountDeletionAction,
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
            "Fence access, acknowledge Agent quiescence, and schedule permanent deletion from a current session, or resume one exact retained lost-response request after that session is revoked.",
          identifier: "account.delete",
          summary: "Delete Account",
        }),
      ),
  );
