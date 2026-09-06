// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer requires a native server factory.
import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { inspect } from "./executor.ts";
import { Host } from "./host.ts";
import { BrowserRuntime } from "./browser-runtime.ts";

const Configuration = Schema.Struct({
  databasePath: Schema.String.check(Schema.isPattern(/^\//)),
  hostSessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ownerUserId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  codexCommand: Schema.String.check(Schema.isPattern(/^\//)),
  codexHome: Schema.String.check(Schema.isPattern(/^\//)),
});

// This entry point is excluded from ordinary dev startup and cannot bind publicly.
NodeRuntime.runMain(
  Effect.gen(function* () {
    const enabled = yield* Config.boolean("OSFO_BROWSER_HOST_ENABLED").pipe(
      Config.withDefault(false),
    );
    if (!enabled) return undefined;
    const secret = yield* Config.redacted("OSFO_BROWSER_HOST_TOKEN");
    const token = Redacted.value(secret);
    if (token.length < 32 || token.length > 512)
      return yield* Effect.die(
        new Error("The private transport secret must contain 32 to 512 characters"),
      );
    const raw = yield* Config.all({
      databasePath: Config.string("OSFO_BROWSER_HOST_DATABASE_PATH"),
      hostSessionId: Config.string("OSFO_BROWSER_HOST_SESSION_ID"),
      ownerUserId: Config.string("OSFO_BROWSER_HOST_OWNER_USER_ID"),
      codexCommand: Config.string("OSFO_BROWSER_HOST_CODEX_COMMAND"),
      codexHome: Config.string("OSFO_BROWSER_HOST_CODEX_HOME"),
    });
    const configuration = yield* Schema.decodeEffect(Configuration)(raw);
    const configuredOrigins = yield* Config.string("OSFO_BROWSER_HOST_ALLOWED_ORIGINS").pipe(
      Config.withDefault("[]"),
    );
    const allowedOrigins = yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Array(
          Schema.String.check(
            Schema.makeFilter(
              (value) =>
                URL.canParse(value) &&
                new URL(value).origin === value &&
                (value.startsWith("https://") || /^http:\/\/127\.0\.0\.1:\d+$/.test(value)),
            ),
          ),
        ).check(Schema.isMaxLength(8)),
      ),
    )(configuredOrigins);
    process.umask(0o077);
    const browser =
      allowedOrigins.length === 0
        ? undefined
        : {
            runtime: yield* BrowserRuntime.make(configuration),
            allowedOrigins,
          };
    const host = yield* Host.make({ ...configuration, token }, inspect(configuration), browser);
    const route = HttpRouter.add("POST", "/inventory", (request) =>
      Effect.gen(function* () {
        const result = yield* host.handleRequest(
          "inventory",
          request.headers.authorization,
          request.text,
        );
        return HttpServerResponse.text(result.body, {
          status: result.status,
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        });
      }).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(4096)),
        Effect.timeout("20 seconds"),
        Effect.orElseSucceed(() =>
          HttpServerResponse.empty({ status: 500, headers: { "cache-control": "no-store" } }),
        ),
      ),
    );
    const browserRoute = HttpRouter.add("POST", "/browser", (request) =>
      Effect.gen(function* () {
        const result = yield* host.handleRequest(
          "browser",
          request.headers.authorization,
          request.text,
        );
        return HttpServerResponse.text(result.body, {
          status: result.status,
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        });
      }).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(16_384)),
        Effect.timeout("25 seconds"),
        Effect.orElseSucceed(() =>
          HttpServerResponse.empty({ status: 500, headers: { "cache-control": "no-store" } }),
        ),
      ),
    );
    // A fixed listener prevents two local runtimes from concurrently owning this host.
    const server = HttpRouter.serve(Layer.mergeAll(route, browserRoute)).pipe(
      Layer.provide(
        NodeHttpServer.layer(
          () => createServer({ requestTimeout: 25_000, headersTimeout: 5_000 }),
          { host: "127.0.0.1", port: 39270, gracefulShutdownTimeout: "20 seconds" },
        ),
      ),
    );
    return yield* Layer.launch(server);
  }).pipe(Effect.scoped),
);
