import { Data, Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi";
import { OsfoApi } from "./api.js";
import { Authentication, type SubmitMessagePayload } from "./threads/api.js";

export class CommitUnknown extends Data.TaggedError("CommitUnknown") {}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly authenticationToken: string;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}

const authenticationClient = (token: string) =>
  HttpApiMiddleware.layerClient(Authentication, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token)),
  );

export const makeApiClient = (options: ApiClientOptions) =>
  HttpApiClient.make(OsfoApi, { baseUrl: options.baseUrl }).pipe(
    Effect.provide(authenticationClient(options.authenticationToken)),
    Effect.provide(options.httpClientLayer ?? FetchHttpClient.layer),
  );

export interface SubmitThreadMessage
  extends ApiClientOptions, Pick<SubmitMessagePayload, "idempotencyKey" | "message"> {
  readonly threadId: string;
}

const isAmbiguousClientFailure = (error: unknown) =>
  HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error);

export const submitThreadMessage = Effect.fn("OsfoApiClient.submitThreadMessage")(function* (
  command: SubmitThreadMessage,
) {
  const client = yield* makeApiClient(command);
  const receipt = yield* client.threads
    .submitMessage({
      params: { threadId: command.threadId },
      payload: {
        protocolVersion: 1,
        idempotencyKey: command.idempotencyKey,
        message: command.message,
      },
    })
    .pipe(Effect.catchIf(isAmbiguousClientFailure, () => Effect.fail(new CommitUnknown())));

  if (receipt.threadId !== command.threadId || receipt.idempotencyKey !== command.idempotencyKey) {
    return yield* new CommitUnknown();
  }
  return receipt;
});
