import { createPublicKey, verify } from "node:crypto";
import { PubSubPushAuthenticationRejected, PubSubPushAuthenticator } from "@osfo/agent-run";
import { Clock, Data, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

const NonEmptyText = Schema.String.check(Schema.isNonEmpty());

export const GooglePubSubPushAuthenticationConfigSchema = Schema.Struct({
  audience: NonEmptyText,
  jwksUrl: Schema.URL,
  serviceAccountEmail: NonEmptyText,
});

export type GooglePubSubPushAuthenticationConfig =
  typeof GooglePubSubPushAuthenticationConfigSchema.Type;

export class InvalidGooglePubSubPushAuthenticationConfig extends Data.TaggedError(
  "InvalidGooglePubSubPushAuthenticationConfig",
)<{ readonly cause: unknown }> {}

const GoogleJwkSchema = Schema.Struct({
  alg: Schema.Literal("RS256"),
  e: NonEmptyText,
  kid: NonEmptyText,
  kty: Schema.Literal("RSA"),
  n: NonEmptyText,
  use: Schema.Literal("sig"),
});

const GoogleJwksSchema = Schema.Struct({ keys: Schema.Array(GoogleJwkSchema) });

const JwtHeaderFromJson = Schema.fromJsonString(
  Schema.Struct({ alg: Schema.Literal("RS256"), kid: NonEmptyText }),
);

const JwtPayloadFromJson = Schema.fromJsonString(
  Schema.Struct({
    aud: Schema.Union([NonEmptyText, Schema.Array(NonEmptyText)]),
    email: NonEmptyText,
    email_verified: Schema.Literal(true),
    exp: Schema.Number,
    iat: Schema.Number,
    iss: Schema.Literals(["accounts.google.com", "https://accounts.google.com"]),
    sub: NonEmptyText,
  }),
);

const decodeJwtPart = (value: string) => Buffer.from(value, "base64url").toString("utf8");

const authenticationLayer = (config: GooglePubSubPushAuthenticationConfig) =>
  Layer.effect(
    PubSubPushAuthenticator,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const fetchJwks = client.get(config.jwksUrl).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(GoogleJwksSchema)),
        Effect.mapError(() => new PubSubPushAuthenticationRejected()),
      );
      const cachedJwks = yield* Effect.cachedWithTTL(fetchJwks, "5 minutes");

      const authenticate = Effect.fn("PubSubPushAuthenticator.authenticate")(function* (
        authorization: string | undefined,
      ) {
        if (authorization === undefined || !authorization.startsWith("Bearer ")) {
          return yield* new PubSubPushAuthenticationRejected();
        }
        const token = authorization.slice("Bearer ".length);
        const parts = token.split(".");
        if (parts.length !== 3) return yield* new PubSubPushAuthenticationRejected();
        const [encodedHeader, encodedPayload, encodedSignature] = parts;
        if (
          encodedHeader === undefined ||
          encodedPayload === undefined ||
          encodedSignature === undefined
        ) {
          return yield* new PubSubPushAuthenticationRejected();
        }

        const header = yield* Schema.decodeUnknownEffect(JwtHeaderFromJson)(
          decodeJwtPart(encodedHeader),
        ).pipe(Effect.mapError(() => new PubSubPushAuthenticationRejected()));
        const payload = yield* Schema.decodeUnknownEffect(JwtPayloadFromJson)(
          decodeJwtPart(encodedPayload),
        ).pipe(Effect.mapError(() => new PubSubPushAuthenticationRejected()));
        const jwks = yield* cachedJwks;
        const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid);
        if (jwk === undefined) return yield* new PubSubPushAuthenticationRejected();

        const publicKey = yield* Effect.try({
          try: () =>
            createPublicKey({
              format: "jwk",
              key: {
                alg: jwk.alg,
                e: jwk.e,
                kid: jwk.kid,
                kty: jwk.kty,
                n: jwk.n,
                use: jwk.use,
              },
            }),
          catch: () => new PubSubPushAuthenticationRejected(),
        });
        const signatureValid = verify(
          "RSA-SHA256",
          Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
          publicKey,
          Buffer.from(encodedSignature, "base64url"),
        );
        const nowSeconds = (yield* Clock.currentTimeMillis) / 1_000;
        const audienceMatches = Array.isArray(payload.aud)
          ? payload.aud.includes(config.audience)
          : payload.aud === config.audience;
        if (
          !signatureValid ||
          !audienceMatches ||
          payload.email !== config.serviceAccountEmail ||
          payload.exp <= nowSeconds ||
          payload.iat > nowSeconds + 300
        ) {
          return yield* new PubSubPushAuthenticationRejected();
        }
      });

      return PubSubPushAuthenticator.of({ authenticate });
    }),
  );

export const makeGooglePubSubPushAuthenticatorLayer = (
  config: GooglePubSubPushAuthenticationConfig,
) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(GooglePubSubPushAuthenticationConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidGooglePubSubPushAuthenticationConfig({ cause })),
      Effect.map(authenticationLayer),
    ),
  );
