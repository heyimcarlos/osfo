import { generateKeyPairSync, sign } from "node:crypto";
import { PubSubPushAuthenticator } from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeGooglePubSubPushAuthenticatorLayer } from "../src/push-authentication.js";

const audience = "https://worker.test/v1/pubsub/agent-runs:push";
const serviceAccountEmail = "pubsub@osfo.test";
const keyId = "test-key-1";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const publicJwk = publicKey.export({ format: "jwk" });

const token = (overrides: { readonly aud?: string; readonly email?: string } = {}) => {
  const now = 0;
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: keyId })).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(
    JSON.stringify({
      aud: overrides.aud ?? audience,
      email: overrides.email ?? serviceAccountEmail,
      email_verified: true,
      exp: now + 600,
      iat: now,
      iss: "https://accounts.google.com",
      sub: "pubsub-service-account-subject",
    }),
  ).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
};

const http = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          keys: [
            {
              alg: "RS256",
              e: publicJwk.e,
              kid: keyId,
              kty: "RSA",
              n: publicJwk.n,
              use: "sig",
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  ),
);

const authenticate = (jwt: string) =>
  PubSubPushAuthenticator.use((authenticator) => authenticator.authenticate(`Bearer ${jwt}`)).pipe(
    Effect.provide(
      makeGooglePubSubPushAuthenticatorLayer({
        audience,
        jwksUrl: new URL("https://jwks.test/certs"),
        serviceAccountEmail,
      }),
    ),
    Effect.provideService(HttpClient.HttpClient, http),
  );

describe("Google Pub/Sub push OIDC authentication", () => {
  it.effect("verifies signature, issuer, audience, expiry, and service account", () =>
    Effect.gen(function* () {
      yield* authenticate(token());

      const wrongAudience = yield* authenticate(token({ aud: "https://wrong.test" })).pipe(
        Effect.exit,
      );
      const wrongServiceAccount = yield* authenticate(token({ email: "other@osfo.test" })).pipe(
        Effect.exit,
      );

      expect(Exit.isFailure(wrongAudience)).toBe(true);
      expect(Exit.isFailure(wrongServiceAccount)).toBe(true);
    }),
  );
});
