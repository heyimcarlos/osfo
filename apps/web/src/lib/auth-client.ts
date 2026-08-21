import { phoneNumberClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { apiBaseURL } from "../config";

const authBaseURL = new URL("/auth", apiBaseURL).href.replace(/\/$/, "");

/** Browser client for the Osfo Better Auth Worker routes. */
export const authClient = createAuthClient({
  baseURL: authBaseURL,
  plugins: [phoneNumberClient()],
});

/** Add email and password sign-in to the authenticated Phone Account. */
export const setLoginCredentials = (
  email: string,
  newPassword: string,
): Promise<{ readonly error: string | null }> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(`${authBaseURL}/set-login-credentials`).pipe(
      HttpClientRequest.bodyJson({ email, newPassword }),
    );
    const response = yield* client.execute(request);
    if (response.status >= 200 && response.status < 300) return { error: null };
    const body: AuthErrorBody = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AuthErrorResponse)),
      Effect.orElseSucceed(() => emptyAuthErrorBody),
    );
    return { error: body.error ?? "The password could not be configured." };
  }).pipe(
    Effect.orElseSucceed(() => ({ error: "The password could not be configured." })),
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser auth adapter owns its Fetch runtime.
    Effect.provide(authHttpClient),
    Effect.runPromise,
  );

interface AuthErrorBody {
  readonly error?: string;
}

const AuthErrorResponse = Schema.Struct({ error: Schema.optionalKey(Schema.String) });
const emptyAuthErrorBody = {} satisfies AuthErrorBody;

const authHttpClient = FetchHttpClient.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: "include",
    }),
  ),
);
