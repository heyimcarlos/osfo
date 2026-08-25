import {
  Api,
  type AccountDeletionActionPresentation,
  type BillingReconciliationRequest,
  ChannelLinkInviteToken,
  type HelpArea,
  type RegistrationLocale,
} from "@osfo/api";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import { apiBaseURL } from "../config";

const httpClientLayer = FetchHttpClient.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: "include",
    }),
  ),
);
const apiClient = HttpApiClient.make(Api, { baseUrl: apiBaseURL }).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
  Effect.provide(httpClientLayer),
);

/** Inspect a Channel Link Invite without exposing its represented external address. */
export const inspectChannelLinkInvite = (token: string) =>
  Effect.gen(function* () {
    const parsedToken = yield* Schema.decodeEffect(ChannelLinkInviteToken)(token);
    const client = yield* apiClient;
    return yield* client.channelLinks.inspect({ params: { token: parsedToken } });
  });

/** Accept a Channel Link Invite for the server-authenticated User. */
export const acceptChannelLinkInvite = (token: string) =>
  Effect.gen(function* () {
    const parsedToken = yield* Schema.decodeEffect(ChannelLinkInviteToken)(token);
    const client = yield* apiClient;
    return yield* client.channelLinks.accept({ params: { token: parsedToken } });
  });

/** Complete authenticated registration through the shared typed contract. */
export interface CompleteRegistrationPayload {
  readonly helpAreas: ReadonlyArray<HelpArea>;
  readonly locale: RegistrationLocale;
  readonly preferredName: string | null;
}

/** Complete authenticated registration through the shared typed API contract. */
export const completeRegistration = (payload: CompleteRegistrationPayload) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.registration.complete({ payload });
  });

/** Inspect the authenticated User's current safe billing state. */
export const inspectBilling = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.billing.inspect();
});

/** Start or recover Stripe-hosted Adventurer Checkout. */
export const startBillingCheckout = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.billing.checkout({ payload: {} });
});

/** Open Stripe Customer Portal for ordinary billing changes. */
export const openBillingPortal = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.billing.portal({ payload: {} });
});

/** Reconcile current Stripe state after a hosted Checkout or Portal return. */
export const reconcileBilling = (payload: BillingReconciliationRequest) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    if (payload.reason === "checkoutReturn") {
      return yield* client.billing.reconcile({ payload });
    }
    return yield* client.billing.reconcile({ payload });
  });

/** Fetch the exact server-owned Action that can permanently delete this account. */
export const presentAccountDeletion = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.account.presentAccountDeletion();
});

/** Consume the caller's exact Approval and start permanent account deletion. */
export const requestAccountDeletion = (presentation: AccountDeletionActionPresentation) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.account.deleteAccount({
      payload: {
        approval: { decision: "approved", presentation },
        confirmation: presentation.confirmation,
      },
    });
  });
