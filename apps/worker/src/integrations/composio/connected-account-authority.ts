import { Schema } from "effect";

const RevokeConnectedAccountResponse = Schema.Struct({
  connected_account: Schema.Struct({
    id: Schema.String,
    status: Schema.Literal("REVOKED"),
  }),
  revoked_tokens: Schema.Unknown,
});

/** Synchronously revoke one exact Composio connected account through the v3.1 authority API. */
interface ConnectedAccountAuthorityClient {
  readonly post: (path: string) => PromiseLike<{
    readonly connected_account?: { readonly id: string; readonly status: string };
    readonly id?: string;
    readonly revoked_tokens?: unknown;
    readonly status?: string;
  }>;
}

export const revoke = (
  client: ConnectedAccountAuthorityClient,
  connectionId: string,
): Promise<void> =>
  Promise.resolve(
    client.post(`/api/v3.1/connected_accounts/${encodeURIComponent(connectionId)}/revoke`),
  )
    .then(Schema.decodeUnknownPromise(RevokeConnectedAccountResponse))
    .then(({ connected_account: revoked }) => {
      if (revoked.id !== connectionId) {
        throw new Error("Composio revoked a different connected account");
      }
    });

export * as ComposioConnectedAccountAuthority from "./connected-account-authority";
