/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import { productApiLayer } from "./cors";

it.effect("allows browser account deletion through the product API preflight", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpRouter.add("DELETE", "/v1/account", HttpServerResponse.empty()).pipe(
          Layer.provide(productApiLayer(["http://localhost:5173"])),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (app) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          app.handler(
            new Request("http://localhost/v1/account", {
              headers: {
                "Access-Control-Request-Method": "DELETE",
                Origin: "http://localhost:5173",
              },
              method: "OPTIONS",
            }),
          ),
        );

        expect(response.status).toBe(204);
        expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
      }),
    (app) => Effect.promise(() => app.dispose()),
  ),
);
