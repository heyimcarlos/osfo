import { phoneNumberClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { Effect, Exit, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

const authBaseURL = new URL("/auth", import.meta.env.VITE_API_URL).href.replace(/\/$/, "");

/** Browser client for the Osfo Better Auth Worker routes. */
export const authClient = createAuthClient({
  baseURL: authBaseURL,
  plugins: [phoneNumberClient()],
});

/** Send SMS for a channel-first invitation without exposing provider-owned identity facts. */
export const sendInvitationOtp = (token: string, phoneNumber?: string) =>
  phoneNumber === undefined
    ? invitationAuthRequest("send-otp", { token })
    : invitationAuthRequest("send-otp", { phoneNumber, token });

/** Verify SMS for an invitation-owned phone number and retain the Better Auth session cookie. */
export const verifyInvitationOtp = (token: string, code: string, phoneNumber?: string) =>
  phoneNumber === undefined
    ? invitationAuthRequest("verify", { code, token })
    : invitationAuthRequest("verify", { code, phoneNumber, token });

type InvitationAuthBody =
  | { readonly phoneNumber?: string; readonly token: string }
  | { readonly code: string; readonly phoneNumber?: string; readonly token: string };

const invitationHttpClient = FetchHttpClient.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: "include",
    }),
  ),
);

const invitationAuthRequest = (action: "send-otp" | "verify", body: InvitationAuthBody) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(`${authBaseURL}/onboarding/${action}`).pipe(
      HttpClientRequest.bodyJson(body),
    );
    yield* client.execute(request).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser auth adapter owns its Fetch runtime.
    Effect.provide(invitationHttpClient),
    Effect.runPromiseExit,
    (promise) => promise.then((exit) => ({ error: Exit.isFailure(exit) ? exit : null })),
  );
