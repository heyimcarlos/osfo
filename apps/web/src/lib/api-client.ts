import { Api } from "@osfo/api";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const apiBaseURL = new URL(import.meta.env.VITE_API_URL).href.replace(/\/$/, "");
const httpClientLayer = FetchHttpClient.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: "include",
    }),
  ),
);

/** Complete registration through the shared typed API contract. */
export const completeRegistration = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api, { baseUrl: apiBaseURL });
  return yield* client.registration.complete({ payload: {} });
}).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
  Effect.provide(httpClientLayer),
);
