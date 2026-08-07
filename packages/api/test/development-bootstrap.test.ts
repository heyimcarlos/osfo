import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";

import { createDevelopmentDemoSession, getDevelopmentBootstrapCapability } from "../src/client";
import {
  DevelopmentBootstrapRejected,
  DevelopmentDemoBootstrap,
  DevelopmentDemoSession,
} from "../src/development-bootstrap";
import { DevelopmentBootstrapApiLive } from "../src/server";

const session = new DevelopmentDemoSession({
  authenticationToken: "osfo_demo_generated-once",
  expiresAt: "2026-08-08T02:00:00.000Z",
  productionQualification: "MISSING",
  protocolVersion: 1,
  scope: "development",
  threadId: "3aa3c4d5-ea1c-47f8-b9e0-662116a14014",
});

const makeHarness = (create: DevelopmentDemoBootstrap["Service"]["create"]) => {
  const bootstrap = DevelopmentDemoBootstrap.of({ create });
  const web = HttpRouter.toWebHandler(
    DevelopmentBootstrapApiLive.pipe(
      Layer.provide(Layer.succeed(DevelopmentDemoBootstrap)(bootstrap)),
      Layer.provideMerge(HttpServer.layerServices),
    ),
  );
  const context = Context.make(DevelopmentDemoBootstrap, bootstrap);
  const observed: Array<{
    readonly body: string;
    readonly code: string | null;
    readonly url: string;
  }> = [];
  const handler = (request: Request) => web.handler(request, context);
  const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request, _url, signal) =>
      Effect.gen(function* () {
        const webRequest = yield* HttpClientRequest.toWeb(request, { signal });
        observed.push({
          body: yield* Effect.promise(() => webRequest.clone().text()),
          code: webRequest.headers.get("x-osfo-demo-bootstrap-code"),
          url: webRequest.url,
        });
        const webResponse = yield* Effect.promise(() => handler(webRequest));
        return HttpClientResponse.fromWeb(request, webResponse);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.EncodeError({ request, cause }),
            }),
        ),
      ),
    ),
  );
  return {
    dispose: () => web.dispose(),
    handler,
    httpClientLayer,
    observed,
  };
};

describe("development demo bootstrap API", () => {
  it("advertises the development-only capability through the typed client", async () => {
    const harness = makeHarness(() => Effect.succeed(session));
    try {
      const capability = await Effect.runPromise(
        getDevelopmentBootstrapCapability({
          baseUrl: "http://osfo.test",
          httpClientLayer: harness.httpClientLayer,
        }),
      );
      expect(capability).toEqual({
        enabled: true,
        productionQualification: "MISSING",
        scope: "development",
      });
      expect(harness.observed).toEqual([
        {
          body: "",
          code: null,
          url: "http://osfo.test/v1/development/demo-sessions/capability",
        },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("returns one no-store development credential through the typed client", async () => {
    let observedCode: string | undefined;
    const harness = makeHarness(({ accessCode }) => {
      observedCode = accessCode;
      return Effect.succeed(session);
    });
    try {
      const created = await Effect.runPromise(
        createDevelopmentDemoSession({
          accessCode: "operator-entered-code",
          baseUrl: "http://osfo.test",
          httpClientLayer: harness.httpClientLayer,
        }),
      );
      expect(created).toEqual(session);
      expect(observedCode).toBe("operator-entered-code");
      expect(harness.observed).toEqual([
        {
          body: "",
          code: "operator-entered-code",
          url: "http://osfo.test/v1/development/demo-sessions",
        },
      ]);

      const response = await harness.handler(
        new Request("http://osfo.test/v1/development/demo-sessions", {
          method: "POST",
          headers: { "x-osfo-demo-bootstrap-code": "operator-entered-code" },
        }),
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const encoded = await response.text();
      expect(encoded.match(/osfo_demo_generated-once/gu)).toHaveLength(1);
      expect(encoded).toContain('"productionQualification":"MISSING"');
    } finally {
      await harness.dispose();
    }
  });

  it("rejects invalid authority without echoing the access code", async () => {
    const harness = makeHarness(() => Effect.fail(new DevelopmentBootstrapRejected()));
    try {
      const accessCode = "must-not-be-reflected";
      const response = await harness.handler(
        new Request("http://osfo.test/v1/development/demo-sessions", {
          method: "POST",
          headers: { "x-osfo-demo-bootstrap-code": accessCode },
        }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toContain(accessCode);
    } finally {
      await harness.dispose();
    }
  });
});
