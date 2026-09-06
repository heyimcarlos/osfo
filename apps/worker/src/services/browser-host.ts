import {
  BrowserRequest,
  BrowserResponse,
  encodeBrowserRequest,
  InventoryRequest,
  InventoryResponse,
  requestIdentity,
} from "@osfo/api/browser-host";
import { Effect, Schema, Stream, type Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ThinkSubmissionId, UserId } from "../domain";

export interface Binding {
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly endpoint: string;
  readonly hostSessionId: string;
  readonly ownerUserId: string;
  readonly token: Redacted.Redacted;
}

export interface Inspection {
  readonly operationId: string;
  readonly turnId: ThinkSubmissionId;
  readonly userId: UserId;
}

export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()(
  "BrowserUnavailable",
  { message: Schema.String },
) {}

export interface Interface<Error = BrowserUnavailable> {
  readonly inspect: (request: Inspection) => Effect.Effect<InventoryResponse["outcome"], Error>;
}

/** Only the provisioned owner can advertise this private host as available. */
export const isAvailable = (binding: Binding | null, userId: UserId): boolean =>
  binding !== null && binding.ownerUserId === userId;

/** Admission precedes transport; every response must retain the exact request identity. */
export const make = <Error>(options: {
  readonly authorize: (request: Inspection) => Effect.Effect<void, Error>;
  readonly binding: Binding | null;
  readonly dispatch: (
    request: InventoryRequest,
    binding: Binding,
  ) => Effect.Effect<InventoryResponse, BrowserUnavailable>;
}): Interface<Error | BrowserUnavailable> => ({
  inspect: Effect.fn("BrowserHost.inspect")(function* (inspection: Inspection) {
    const binding = options.binding;
    if (binding === null || !isAvailable(binding, inspection.userId)) {
      return yield* unavailable();
    }
    const request = yield* Schema.decodeEffect(InventoryRequest)({
      hostSessionId: binding.hostSessionId,
      operation: "inventory",
      operationId: inspection.operationId,
      ownerUserId: inspection.userId,
      turnId: inspection.turnId,
    }).pipe(Effect.mapError(unavailable));
    yield* options.authorize(inspection);
    const response = yield* options.dispatch(request, binding);
    if (requestIdentity(response.request) !== requestIdentity(request)) {
      return yield* unavailable();
    }
    return response.outcome;
  }),
});

const unavailable = () =>
  new BrowserUnavailable({ message: "The private browser host is unavailable for this turn." });

export const dispatch = Effect.fn("BrowserHost.dispatch")(
  function* (request: InventoryRequest, binding: Binding) {
    const client = yield* HttpClient.HttpClient;
    const httpRequest = yield* HttpClientRequest.post(binding.endpoint).pipe(
      HttpClientRequest.bearerToken(binding.token),
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.schemaBodyJson(InventoryRequest)(request),
    );
    const response = yield* client.execute(httpRequest);
    if (response.status !== 200) return yield* unavailable();
    const bytes = yield* Stream.runFoldEffect(
      response.stream,
      () => new Uint8Array(0),
      (body, chunk) => {
        if (body.byteLength + chunk.byteLength > 16_384) return Effect.fail(unavailable());
        const joined = new Uint8Array(body.byteLength + chunk.byteLength);
        joined.set(body);
        joined.set(chunk, body.byteLength);
        return Effect.succeed(joined);
      },
    );
    return yield* Schema.decodeEffect(Schema.fromJsonString(InventoryResponse))(
      new TextDecoder().decode(bytes),
    );
  },
  (effect) =>
    effect.pipe(
      // Workerd rejects redirect:error. Manual mode leaves redirects for the status check above.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("20 seconds"),
      Effect.mapError(unavailable),
    ),
);

/** The same private host connection carries fixed browser commands with bounded evidence. */
export const execute = Effect.fn("BrowserHost.execute")(
  function* (request: BrowserRequest, binding: Binding) {
    if (
      request.ownerUserId !== binding.ownerUserId ||
      request.hostSessionId !== binding.hostSessionId
    )
      return yield* unavailable();
    const client = yield* HttpClient.HttpClient;
    const httpRequest = yield* HttpClientRequest.post(
      new URL("/browser", binding.endpoint).href,
    ).pipe(
      HttpClientRequest.bearerToken(binding.token),
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.schemaBodyJson(BrowserRequest)(request),
    );
    const response = yield* client.execute(httpRequest);
    if (response.status !== 200) return yield* unavailable();
    const bytes = yield* Stream.runFoldEffect(
      response.stream,
      () => new Uint8Array(0),
      (body, chunk) => {
        if (body.byteLength + chunk.byteLength > 262_144) return Effect.fail(unavailable());
        const joined = new Uint8Array(body.byteLength + chunk.byteLength);
        joined.set(body);
        joined.set(chunk, body.byteLength);
        return Effect.succeed(joined);
      },
    );
    const result = yield* Schema.decodeEffect(Schema.fromJsonString(BrowserResponse))(
      new TextDecoder().decode(bytes),
    );
    if (encodeBrowserRequest(result.request) !== encodeBrowserRequest(request))
      return yield* unavailable();
    return result.outcome;
  },
  (effect) =>
    effect.pipe(
      // Workerd rejects redirect:error. Manual mode leaves redirects for the status check above.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("25 seconds"),
      Effect.mapError(unavailable),
    ),
);

export * as Browser from "./browser-host";
