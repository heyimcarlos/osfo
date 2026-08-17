import { Api, type HelpArea, type OnboardingLocale, RegistrationToken } from "@osfo/api";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const apiBaseURL = new URL(import.meta.env.VITE_API_URL).href.replace(/\/$/, "");
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
  readonly bindingConsent: "accepted" | "refused" | "web-enrollment";
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
