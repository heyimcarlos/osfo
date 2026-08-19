import {
  Api,
  type BillingReconciliationRequest,
  type ChannelProvider,
  type HelpArea,
  type OnboardingLocale,
  RegistrationToken,
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

/** Inspect one resumable Registration Invitation without revealing account existence. */
export const inspectRegistrationInvitation = (token: string) =>
  Effect.gen(function* () {
    const parsedToken = yield* Schema.decodeEffect(RegistrationToken)(token);
    const client = yield* apiClient;
    return yield* client.onboarding.inspectInvitation({
      params: { token: parsedToken },
    });
  });

/** Complete authenticated onboarding through the shared typed contract. */
export interface CompleteOnboardingPayload {
  readonly existingProfileChoice: "apply" | "keep" | null;
  readonly helpAreas: ReadonlyArray<HelpArea>;
  readonly invitationToken: string | null;
  readonly locale: OnboardingLocale;
  readonly preferredName: string | null;
}

/** Complete authenticated onboarding through the shared typed API contract. */
export const completeOnboarding = (payload: CompleteOnboardingPayload) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    const invitationToken =
      payload.invitationToken === null
        ? null
        : yield* Schema.decodeEffect(RegistrationToken)(payload.invitationToken);
    return yield* client.onboarding.complete({
      payload: { ...payload, invitationToken },
    });
  });

/** Start an explicit messaging channel connection for the authenticated User. */
export const startChannelEnrollment = (provider: ChannelProvider) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.onboarding.startChannelEnrollment({ payload: { provider } });
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
