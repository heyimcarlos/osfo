import { Data, Effect, Layer, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi";
import { OsfoApi } from "./api.js";
import {
  AdmissionCommitUnknown,
  AdmissionNotAccepted,
  AdmissionUnavailable,
  Authentication,
  AuthenticationRejected,
  CapacityRejected,
  IdempotencyConflict,
  MalformedRequest,
  ThreadNotFound,
  type SubmitMessagePayload,
} from "./threads/api.js";

export class CommitUnknown extends Data.TaggedError("CommitUnknown") {}

export class UnexpectedThreadResponse extends Data.TaggedError("UnexpectedThreadResponse") {}

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

const isDefiniteSubmissionRejection = Schema.is(
  Schema.Union([
    AdmissionUnavailable,
    AdmissionNotAccepted,
    AuthenticationRejected,
    CapacityRejected,
    IdempotencyConflict,
    MalformedRequest,
    ThreadNotFound,
  ]),
);

const isDefiniteReconciliationResult = Schema.is(
  Schema.Union([AdmissionNotAccepted, IdempotencyConflict, ThreadNotFound]),
);

const isAmbiguousClientFailure = (error: unknown) =>
  HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error);

export const submitThreadMessage = Effect.fn("OsfoApiClient.submitThreadMessage")(function* (
  command: SubmitThreadMessage,
) {
  const payload = {
    protocolVersion: 1 as const,
    idempotencyKey: command.idempotencyKey,
    message: command.message,
  };
  const submit = Effect.gen(function* () {
    const client = yield* makeApiClient(command);
    const receipt = yield* client.threads.submitMessage({
      params: { threadId: command.threadId },
      payload,
    });
    if (
      receipt.threadId !== command.threadId ||
      receipt.idempotencyKey !== command.idempotencyKey
    ) {
      return yield* new CommitUnknown();
    }
    return receipt;
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(AdmissionCommitUnknown)(error) || !isDefiniteSubmissionRejection(error)
        ? new CommitUnknown()
        : error,
    ),
  );

  const reconcile = Effect.gen(function* () {
    const client = yield* makeApiClient(command);
    const receipt = yield* client.threads.reconcileMessageAdmission({
      params: { threadId: command.threadId },
      payload,
    });
    if (
      receipt.threadId !== command.threadId ||
      receipt.idempotencyKey !== command.idempotencyKey
    ) {
      return yield* new CommitUnknown();
    }
    return receipt;
  }).pipe(
    Effect.mapError((error) =>
      isDefiniteReconciliationResult(error) ? error : new CommitUnknown(),
    ),
  );

  return yield* submit.pipe(
    Effect.catchTag("CommitUnknown", () =>
      submit.pipe(Effect.matchEffect({ onFailure: () => reconcile, onSuccess: Effect.succeed })),
    ),
  );
});

export interface CancelThreadAgentRun extends ApiClientOptions {
  readonly threadId: string;
  readonly agentRunId: string;
}

export const cancelThreadAgentRun = Effect.fn("OsfoApiClient.cancelThreadAgentRun")(function* (
  command: CancelThreadAgentRun,
) {
  const client = yield* makeApiClient(command);
  const receipt = yield* client.threads
    .cancelAgentRun({
      params: { threadId: command.threadId, agentRunId: command.agentRunId },
      payload: { protocolVersion: 1 },
    })
    .pipe(Effect.catchIf(isAmbiguousClientFailure, () => Effect.fail(new CommitUnknown())));
  if (receipt.agentRunId !== command.agentRunId) return yield* new CommitUnknown();
  return receipt;
});

export interface GetThreadSnapshot extends ApiClientOptions {
  readonly threadId: string;
}

export const getThreadSnapshot = Effect.fn("OsfoApiClient.getThreadSnapshot")(function* (
  command: GetThreadSnapshot,
) {
  const client = yield* makeApiClient(command);
  const snapshot = yield* client.threads.getSnapshot({ params: { threadId: command.threadId } });
  if (snapshot.threadId !== command.threadId) return yield* new UnexpectedThreadResponse();
  return snapshot;
});

export interface StreamThreadEvents extends ApiClientOptions {
  readonly after: string;
  readonly threadId: string;
}

export const streamThreadEvents = Effect.fn("OsfoApiClient.streamThreadEvents")(function* (
  command: StreamThreadEvents,
) {
  const client = yield* makeApiClient(command);
  const response = yield* client.threads.getEvents({
    params: { threadId: command.threadId },
    query: { after: command.after },
  });
  if (!Stream.isStream(response)) return yield* new UnexpectedThreadResponse();
  return response;
});
