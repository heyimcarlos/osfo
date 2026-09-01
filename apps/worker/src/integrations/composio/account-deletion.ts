import ComposioClient from "@composio/client";
import { Effect, Redacted, Schema } from "effect";

import type { UserId } from "../../domain";
import { AccountDeletion } from "../../services/account-deletion";
import { ComposioConnectedAccountAuthority } from "./connected-account-authority";

const supportedToolkits = ["gmail", "googlecalendar", "googledrive"] as const;
const maximumPages = 10;
const ProviderStatus = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const ProviderCursor = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));
const ConnectedAccount = Schema.Struct({
  id: AccountDeletion.IntegrationAuthorityTargetId,
  status: ProviderStatus,
});
const ConnectedAccountListResponse = Schema.Struct({
  items: Schema.Array(ConnectedAccount),
  next_cursor: Schema.optionalKey(Schema.NullOr(ProviderCursor)),
});
const ConnectedAccountDeleteResponse = Schema.Struct({ success: Schema.Literal(true) });

interface ConnectedAccountPayload {
  readonly id?: string | null;
  readonly status?: string | null;
}

interface ConnectedAccountListPayload {
  readonly items: ReadonlyArray<ConnectedAccountPayload> | null;
  readonly next_cursor?: string | null;
}

interface ConnectedAccountDeletePayload {
  readonly success: boolean | string | null;
}

interface ConnectedAccountsPort {
  readonly delete: (connectionId: string) => Promise<ConnectedAccountDeletePayload>;
  readonly list: (options: {
    readonly connected_account_ids?: Array<string>;
    readonly cursor?: string;
    readonly limit: number;
    readonly account_type: "PRIVATE";
    readonly toolkit_slugs: Array<string>;
    readonly user_ids: Array<string>;
  }) => Promise<ConnectedAccountListPayload>;
  readonly revoke: (
    connectionId: string,
  ) => Promise<{ readonly id: string; readonly status: "REVOKED" }>;
}

/** Revoke every Composio authority owned by one deleting Osfo User. */
export const make = (apiKey: Redacted.Redacted): AccountDeletion.PortInterface["integrations"] => {
  const client = new ComposioClient({
    apiKey: Redacted.value(apiKey),
    maxRetries: 0,
  });
  return makeFromClient({
    delete: (connectionId) => client.connectedAccounts.delete(connectionId),
    list: (options) => client.connectedAccounts.list(options),
    revoke: (connectionId) =>
      ComposioConnectedAccountAuthority.revoke(client, connectionId).then(() => ({
        id: connectionId,
        status: "REVOKED" as const,
      })),
  });
};

/** Adapt the exact current Composio connected-account API behind account deletion. */
export const makeFromClient = (
  connectedAccounts: ConnectedAccountsPort,
): AccountDeletion.PortInterface["integrations"] => ({
  pending: (userId) =>
    listAll(connectedAccounts, userId).pipe(
      Effect.map((items) =>
        items.map(({ id }) => ({
          connectionId: AccountDeletion.IntegrationAuthorityTargetId.make(id),
          userId,
        })),
      ),
    ),
  remove: (target) =>
    findExact(connectedAccounts, target).pipe(
      Effect.flatMap((account) => {
        if (account === null) return Effect.void;
        if (account.status !== "REVOKED") {
          return Effect.fail(deletionUnavailable("removeIntegrationAuthority"));
        }
        return providerCall("removeIntegrationAuthority", () =>
          connectedAccounts.delete(target.connectionId),
        ).pipe(
          Effect.flatMap((response) =>
            decodeConnectedAccountDeleteResponse("removeIntegrationAuthority", response),
          ),
          Effect.asVoid,
          Effect.andThen(findExact(connectedAccounts, target)),
          Effect.flatMap((remaining) =>
            remaining === null
              ? Effect.void
              : Effect.fail(deletionUnavailable("confirmIntegrationAuthorityRemoved")),
          ),
        );
      }),
    ),
  revoke: (target) =>
    findExact(connectedAccounts, target).pipe(
      Effect.flatMap((account) => {
        if (account === null) {
          return Effect.fail(deletionUnavailable("revokeIntegrationAuthority"));
        }
        if (account.status === "REVOKED") return Effect.void;
        return providerCall("revokeIntegrationAuthority", () =>
          connectedAccounts.revoke(target.connectionId),
        ).pipe(
          Effect.flatMap((response) =>
            response.id === target.connectionId && response.status === "REVOKED"
              ? Effect.void
              : Effect.fail(deletionUnavailable("revokeIntegrationAuthority")),
          ),
        );
      }),
    ),
});

const listAll = (connectedAccounts: ConnectedAccountsPort, userId: UserId) =>
  Effect.gen(function* () {
    const items: Array<typeof ConnectedAccount.Type> = [];
    let cursor: string | undefined;
    for (let page = 0; page < maximumPages; page += 1) {
      const baseOptions = {
        account_type: "PRIVATE" as const,
        limit: 100,
        toolkit_slugs: [...supportedToolkits],
        user_ids: [userId],
      };
      const options = cursor === undefined ? baseOptions : { ...baseOptions, cursor };
      const response = yield* providerCall("discoverIntegrationAuthorities", () =>
        connectedAccounts.list(options),
      ).pipe(
        Effect.flatMap((value) =>
          decodeConnectedAccountListResponse("discoverIntegrationAuthorities", value),
        ),
      );
      items.push(...response.items);
      if (response.next_cursor === undefined || response.next_cursor === null) return items;
      cursor = response.next_cursor;
    }
    return yield* deletionUnavailable("discoverIntegrationAuthorities");
  });

const findExact = (
  connectedAccounts: ConnectedAccountsPort,
  target: AccountDeletion.IntegrationAuthorityTarget,
) =>
  providerCall("inspectIntegrationAuthority", () =>
    connectedAccounts.list({
      account_type: "PRIVATE",
      connected_account_ids: [target.connectionId],
      limit: 2,
      toolkit_slugs: [...supportedToolkits],
      user_ids: [target.userId],
    }),
  ).pipe(
    Effect.flatMap((value) =>
      decodeConnectedAccountListResponse("inspectIntegrationAuthority", value),
    ),
    Effect.flatMap(({ items }) => {
      if (items.length === 0) return Effect.succeed(null);
      const account = items[0];
      return items.length === 1 && account?.id === target.connectionId
        ? Effect.succeed(account)
        : Effect.fail(deletionUnavailable("inspectIntegrationAuthority"));
    }),
  );

const providerCall = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => deletionUnavailable(operation, cause),
  });

const decodeConnectedAccountListResponse = (
  operation: string,
  value: ConnectedAccountListPayload,
) =>
  Schema.decodeUnknownEffect(ConnectedAccountListResponse)(value).pipe(
    Effect.mapError((cause) => deletionUnavailable(operation, cause)),
  );

const decodeConnectedAccountDeleteResponse = (
  operation: string,
  value: ConnectedAccountDeletePayload,
) =>
  Schema.decodeUnknownEffect(ConnectedAccountDeleteResponse)(value).pipe(
    Effect.mapError((cause) => deletionUnavailable(operation, cause)),
  );

const deletionUnavailable = (operation: string, cause: unknown = operation) =>
  new AccountDeletion.AccountDeletionUnavailable({
    cause,
    message: "Integration authority deletion is unavailable",
    operation,
  });

export * as ComposioAccountDeletion from "./account-deletion";
