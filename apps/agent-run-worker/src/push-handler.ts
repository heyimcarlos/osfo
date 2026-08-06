import { createHash, timingSafeEqual } from "node:crypto";
import { AgentRunWorker, decodePubSubPushDelivery } from "@osfo/agent-run";
import { Effect, Exit, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export const PubSubPushRoutesConfigSchema = Schema.Struct({
  authorizationToken: Schema.NonEmptyString,
});

export type PubSubPushRoutesConfig = typeof PubSubPushRoutesConfigSchema.Type;

const tokenDigest = (value: string) => createHash("sha256").update(value).digest();

const isAuthorized = (authorization: string | undefined, expectedToken: string) => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return false;
  return timingSafeEqual(
    tokenDigest(authorization.slice("Bearer ".length)),
    tokenDigest(expectedToken),
  );
};

export const makePubSubPushRoutes = (config: PubSubPushRoutesConfig) =>
  HttpRouter.add(
    "POST",
    "/v1/pubsub/agent-runs:push",
    Effect.gen(function* () {
      const worker = yield* AgentRunWorker;
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!isAuthorized(request.headers.authorization, config.authorizationToken)) {
        return HttpServerResponse.empty({ status: 401 });
      }

      const decoded = yield* request.json.pipe(
        Effect.flatMap(decodePubSubPushDelivery),
        Effect.exit,
      );
      if (Exit.isFailure(decoded)) return HttpServerResponse.empty({ status: 400 });

      const disposition = yield* worker.handle(decoded.value);
      return disposition.type === "acknowledge"
        ? HttpServerResponse.empty({ status: 204 })
        : HttpServerResponse.empty({ status: 503 });
    }),
  );
