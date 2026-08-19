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

/** Complete registration through the shared typed API contract. */
export const completeRegistration = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api, { baseUrl: apiBaseURL });
  return yield* client.registration.complete({ payload: {} });
}).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
  Effect.provide(httpClientLayer),
);

/** Inspect one resumable Registration Invitation without revealing account existence. */
export const inspectRegistrationInvitation = (token: string) =>
  Effect.gen(function* () {
    const parsedToken = yield* Schema.decodeEffect(RegistrationToken)(token);
    const client = yield* HttpApiClient.make(Api, { baseUrl: apiBaseURL });
    return yield* client.onboarding.inspectInvitation({
      params: { token: parsedToken },
    });
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
    Effect.provide(httpClientLayer),
  );

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
    const client = yield* HttpApiClient.make(Api, { baseUrl: apiBaseURL });
    const invitationToken =
      payload.invitationToken === null
        ? null
        : yield* Schema.decodeEffect(RegistrationToken)(payload.invitationToken);
    return yield* client.onboarding.complete({
      payload: { ...payload, invitationToken },
    });
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
    Effect.provide(httpClientLayer),
  );

/** Start an explicit messaging channel connection for the authenticated User. */
export const startChannelEnrollment = (provider: ChannelProvider) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api, { baseUrl: apiBaseURL });
    return yield* client.onboarding.startChannelEnrollment({ payload: { provider } });
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
    Effect.provide(httpClientLayer),
  );

/** Inspect the authenticated User's current safe billing state. */
export const inspectBilling = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api, { baseUrl: apiBaseURL });
  return yield* client.billing.inspect();
}).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
  Effect.provide(httpClientLayer),
);

/** Start or recover Stripe-hosted Adventurer Checkout. */
export const startBillingCheckout = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api, { baseUrl: apiBaseURL });
  return yield* client.billing.checkout({ payload: {} });
}).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
  Effect.provide(httpClientLayer),
);

/** Open Stripe Customer Portal for ordinary billing changes. */
export const openBillingPortal = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api, { baseUrl: apiBaseURL });
  return yield* client.billing.portal({ payload: {} });
}).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
  Effect.provide(httpClientLayer),
);

/** Reconcile current Stripe state after a hosted Checkout or Portal return. */
export const reconcileBilling = (payload: BillingReconciliationRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api, { baseUrl: apiBaseURL });
    return yield* payload.reason === "checkoutReturn"
      ? client.billing.reconcile({ payload })
      : client.billing.reconcile({ payload });
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
    Effect.provide(httpClientLayer),
  );
