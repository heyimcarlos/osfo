import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/unstable/httpapi";
import { OsfoApi } from "./api.js";
import {
  DevelopmentBootstrapApi,
  DevelopmentBootstrapCapability,
  DevelopmentDemoBootstrap,
} from "./development-bootstrap.js";
import { AgentRunCancellation, MessageAdmission, ThreadResume } from "./services.js";
import {
  ThreadStreamLifecycle,
  threadStreamConnectionRetryAfterSeconds,
} from "./thread-stream-lifecycle.js";
import {
  Authentication,
  AuthenticationRejected,
  AuthenticationToken,
  MalformedRequest,
  RequestValidation,
} from "./threads/api.js";

export const AuthenticationLive = Layer.succeed(Authentication)(
  Authentication.of({
    bearer: (httpEffect, { credential }) => {
      const value = Redacted.value(credential);
      return value.length === 0
        ? Effect.fail(new AuthenticationRejected())
        : Effect.provideService(httpEffect, AuthenticationToken, value);
    },
  }),
);

export const RequestValidationLive = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestValidation,
  (error) => (error.kind === "Body" ? Effect.fail(error) : Effect.fail(new MalformedRequest())),
);

export const ThreadsHandlers = HttpApiBuilder.group(OsfoApi, "threads", (handlers) =>
  handlers
    .handle(
      "submitMessage",
      Effect.fn("OsfoApi.threads.submitMessage")(function* ({ params, payload }) {
        const authenticationToken = yield* AuthenticationToken;
        const admission = yield* MessageAdmission;
        return yield* admission.accept({
          ...payload,
          authenticationToken,
          threadId: params.threadId,
        });
      }),
    )
    .handle(
      "reconcileMessageAdmission",
      Effect.fn("OsfoApi.threads.reconcileMessageAdmission")(function* ({ params, payload }) {
        const authenticationToken = yield* AuthenticationToken;
        const admission = yield* MessageAdmission;
        return yield* admission.reconcile({
          ...payload,
          authenticationToken,
          threadId: params.threadId,
        });
      }),
    )
    .handle(
      "cancelAgentRun",
      Effect.fn("OsfoApi.threads.cancelAgentRun")(function* ({ params, payload }) {
        const authenticationToken = yield* AuthenticationToken;
        const cancellation = yield* AgentRunCancellation;
        return yield* cancellation.cancel({
          ...payload,
          authenticationToken,
          threadId: params.threadId,
          agentRunId: params.agentRunId,
        });
      }),
    )
    .handle(
      "getSnapshot",
      Effect.fn("OsfoApi.threads.getSnapshot")(function* ({ params }) {
        const authenticationToken = yield* AuthenticationToken;
        const resume = yield* ThreadResume;
        return yield* resume.snapshot({
          authenticationToken,
          threadId: params.threadId,
        });
      }),
    )
    .handle(
      "getEvents",
      Effect.fn("OsfoApi.threads.getEvents")(function* ({ params, query }) {
        const authenticationToken = yield* AuthenticationToken;
        const resume = yield* ThreadResume;
        if (query.after !== undefined) {
          const source = yield* resume.stream({
            after: query.after,
            authenticationToken,
            threadId: params.threadId,
          });
          const lifecycle = yield* ThreadStreamLifecycle;
          return yield* lifecycle.open(source);
        }
        const historyRequest = {
          afterPosition: query.afterPosition ?? "0",
          authenticationToken,
          limit: query.limit ?? 100,
          threadId: params.threadId,
        };
        return yield* query.throughPosition === undefined
          ? resume.history(historyRequest)
          : resume.history({ ...historyRequest, throughPosition: query.throughPosition });
      }),
    ),
).pipe(Layer.provide([AuthenticationLive, RequestValidationLive]));

const DevelopmentBootstrapHandlers = HttpApiBuilder.group(
  DevelopmentBootstrapApi,
  "developmentBootstrap",
  (handlers) =>
    handlers
      .handle("getCapability", () =>
        Effect.succeed(
          new DevelopmentBootstrapCapability({
            enabled: true,
            productionQualification: "MISSING",
            scope: "development",
          }),
        ),
      )
      .handle(
        "createDemoSession",
        Effect.fn("OsfoApi.developmentBootstrap.createDemoSession")(function* ({ headers }) {
          const bootstrap = yield* DevelopmentDemoBootstrap;
          return yield* bootstrap.create({ accessCode: headers["x-osfo-demo-bootstrap-code"] });
        }),
      ),
).pipe(Layer.provide(RequestValidationLive));

const DevelopmentBootstrapNoStore = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(httpEffect, (response) =>
      HttpServerResponse.setHeaders(response, {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      }),
    ),
  { global: true },
);

export const DevelopmentBootstrapApiLive = Layer.merge(
  HttpApiBuilder.layer(DevelopmentBootstrapApi).pipe(Layer.provide(DevelopmentBootstrapHandlers)),
  DevelopmentBootstrapNoStore,
);

const ApiRoutes = HttpApiBuilder.layer(OsfoApi, {
  openapiPath: "/openapi.json",
}).pipe(Layer.provide(ThreadsHandlers));

const threadEventsPath = /^\/v1\/threads\/[^/]+\/events(?:\?|$)/u;

const hardenResponse = (requestUrl: string, response: HttpServerResponse.HttpServerResponse) => {
  const authenticated =
    response.status === 401
      ? HttpServerResponse.setHeader(response, "www-authenticate", "Bearer")
      : response;
  const guided =
    response.status === 429 && threadEventsPath.test(requestUrl)
      ? HttpServerResponse.setHeader(
          authenticated,
          "retry-after",
          String(threadStreamConnectionRetryAfterSeconds),
        )
      : authenticated;
  const noStore = HttpServerResponse.setHeaders(guided, {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  return response.headers["content-type"]?.startsWith("text/event-stream") === true
    ? HttpServerResponse.setHeaders(noStore, {
        "cache-control": "private, no-store, no-transform",
        "x-accel-buffering": "no",
      })
    : noStore;
};

const HardenResponses = HttpRouter.middleware(
  (httpEffect) =>
    HttpServerRequest.HttpServerRequest.pipe(
      Effect.flatMap((request) =>
        Effect.map(httpEffect, (response) => hardenResponse(request.url, response)),
      ),
    ),
  {
    global: true,
  },
);

export const OsfoApiLive = Layer.merge(ApiRoutes, HardenResponses);
