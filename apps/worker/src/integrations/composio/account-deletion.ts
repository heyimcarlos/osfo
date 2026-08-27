import ComposioClient from "@composio/client";
import { Effect, Redacted } from "effect";

import type { UserId } from "../../domain";
import { AccountDeletion } from "../../services/account-deletion";

const supportedToolkits = ["gmail", "googlecalendar", "googledrive"] as const;
const maximumPages = 10;

interface ConnectedAccountsPort {
  readonly delete: (
    connectionId: string,
    options: { readonly revoke_on_delete: true },
  ) => Promise<{ readonly revoke_job_id?: string; readonly success: boolean }>;
  readonly list: (options: {
    readonly connected_account_ids?: Array<string>;
    readonly cursor?: string;
    readonly limit: number;
    readonly toolkit_slugs: Array<string>;
    readonly user_ids: Array<string>;
  }) => Promise<{
    readonly items: ReadonlyArray<{ readonly id: string }>;
    readonly next_cursor?: string | null;
  }>;
}

/** Revoke every Composio authority owned by one deleting Osfo User. */
export const make = (apiKey: Redacted.Redacted): AccountDeletion.PortInterface["integrations"] => {
  const client = new ComposioClient({
    apiKey: Redacted.value(apiKey),
    maxRetries: 0,
  });
  return makeFromClient(client.connectedAccounts);
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
  revoke: (target) =>
    providerCall("revokeIntegrationAuthority", () =>
      connectedAccounts.delete(target.connectionId, { revoke_on_delete: true }),
    ).pipe(
      Effect.flatMap((response) =>
        response.success && (response.revoke_job_id?.length ?? 0) > 0
          ? Effect.void
          : Effect.fail(deletionUnavailable("revokeIntegrationAuthority")),
      ),
      Effect.flatMap(() =>
        providerCall("confirmIntegrationAuthorityRevoked", () =>
          connectedAccounts.list({
            connected_account_ids: [target.connectionId],
            limit: 1,
            toolkit_slugs: [...supportedToolkits],
            user_ids: [target.userId],
          }),
        ),
      ),
      Effect.flatMap(({ items }) =>
        items.length === 0
          ? Effect.void
          : Effect.fail(deletionUnavailable("confirmIntegrationAuthorityRevoked")),
      ),
    ),
});

const listAll = (connectedAccounts: ConnectedAccountsPort, userId: UserId) =>
  Effect.gen(function* () {
    const items: Array<{ readonly id: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < maximumPages; page += 1) {
      const baseOptions = {
        limit: 100,
        toolkit_slugs: [...supportedToolkits],
        user_ids: [userId],
      };
      const options = cursor === undefined ? baseOptions : { ...baseOptions, cursor };
      const response = yield* providerCall("discoverIntegrationAuthorities", () =>
        connectedAccounts.list(options),
      );
      items.push(...response.items);
      if (response.next_cursor === undefined || response.next_cursor === null) return items;
      cursor = response.next_cursor;
    }
    return yield* deletionUnavailable("discoverIntegrationAuthorities");
  });

const providerCall = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => deletionUnavailable(operation, cause),
  });

const deletionUnavailable = (operation: string, cause: unknown = operation) =>
  new AccountDeletion.AccountDeletionUnavailable({
    cause,
    message: "Integration authority deletion is unavailable",
    operation,
  });

export * as ComposioAccountDeletion from "./account-deletion";
