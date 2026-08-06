import { Effect, Layer, Redacted } from "effect";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/unstable/httpapi";
import { OsfoApi } from "./api.js";
import { MessageAdmission } from "./services.js";
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
  handlers.handle(
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
  ),
).pipe(Layer.provide([AuthenticationLive, RequestValidationLive]));

export const OsfoApiLive = HttpApiBuilder.layer(OsfoApi, {
  openapiPath: "/openapi.json",
}).pipe(Layer.provide(ThreadsHandlers));
