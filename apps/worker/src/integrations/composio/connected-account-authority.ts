import { Schema } from "effect";

const RevokedConnectedAccount = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("REVOKED"),
});

/** Synchronously revoke one exact Composio connected account through the v3.1 authority API. */
interface ConnectedAccountAuthorityClient {
  readonly post: (path: string) => PromiseLike<{ readonly id: string; readonly status: string }>;
}

export const revoke = (
  client: ConnectedAccountAuthorityClient,
  connectionId: string,
): Promise<void> =>
  Promise.resolve(
    client.post(`/api/v3.1/connected_accounts/${encodeURIComponent(connectionId)}/revoke`),
  )
    .then(Schema.decodeUnknownPromise(RevokedConnectedAccount))
    .then((revoked) => {
      if (revoked.id !== connectionId) {
        throw new Error("Composio revoked a different connected account");
      }
    });

export * as ComposioConnectedAccountAuthority from "./connected-account-authority";
