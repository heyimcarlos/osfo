import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/unstable/httpapi";
import { OsfoApi } from "./api.js";
import { MessageAdmission, ThreadResume } from "./services.js";
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
          return yield* resume.stream({
            after: query.after,
            authenticationToken,
            threadId: params.threadId,
          });
        }
        return yield* resume.history({
          afterPosition: query.afterPosition ?? "0",
          authenticationToken,
          limit: query.limit ?? 100,
          threadId: params.threadId,
          ...(query.throughPosition === undefined
            ? {}
            : { throughPosition: query.throughPosition }),
        });
      }),
    ),
).pipe(Layer.provide([AuthenticationLive, RequestValidationLive]));

const ApiRoutes = HttpApiBuilder.layer(OsfoApi, {
  openapiPath: "/openapi.json",
}).pipe(Layer.provide(ThreadsHandlers));

const NoStoreResponses = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(httpEffect, HttpServerResponse.setHeader("cache-control", "private, no-store")),
  { global: true },
);

export const OsfoApiLive = Layer.merge(ApiRoutes, NoStoreResponses);
