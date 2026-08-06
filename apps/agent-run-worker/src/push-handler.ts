import { AgentRunWorker, decodePubSubPushDelivery, PubSubPushAuthenticator } from "@osfo/agent-run";
import { Effect, Exit } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export const PubSubPushRoutes = HttpRouter.add(
  "POST",
  "/v1/pubsub/agent-runs:push",
  Effect.gen(function* () {
    const worker = yield* AgentRunWorker;
    const authenticator = yield* PubSubPushAuthenticator;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authentication = yield* authenticator
      .authenticate(request.headers.authorization)
      .pipe(Effect.exit);
    if (Exit.isFailure(authentication)) {
      return HttpServerResponse.empty({ status: 401 });
    }

    const decoded = yield* request.json.pipe(Effect.flatMap(decodePubSubPushDelivery), Effect.exit);
    if (Exit.isFailure(decoded)) return HttpServerResponse.empty({ status: 400 });

    const disposition = yield* worker.handle(decoded.value);
    return disposition.type === "acknowledge"
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.empty({ status: 503 });
  }),
);
