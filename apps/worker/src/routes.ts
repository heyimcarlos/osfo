import { Api } from "@osfo/api";
import { Effect, Layer, Schema, type ManagedRuntime } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import * as Auth from "./auth";
import type { RuntimeConfig } from "./env";
import * as Handlers from "./handlers";
import type { ExecutionUnit, RuntimeProbeResult } from "./layers";

class CloudflareHostUnavailable extends Schema.TaggedError<CloudflareHostUnavailable>()(
  "CloudflareHostUnavailable",
  {
    cause: Schema.Defect(),
    executionUnit: Schema.Literals(["osfo-agent", "registration-dialogue"]),
    message: Schema.String,
  },
) {}

interface RuntimeProbeStub {
  readonly probeRuntime: () => Promise<RuntimeProbeResult>;
}

interface RuntimeProbeNamespace {
  readonly getByName: (identity: string) => RuntimeProbeStub;
}

/** Cloudflare bindings used by the Worker route tree. */
export interface Bindings {
  readonly OSFO_AGENT: RuntimeProbeNamespace;
  readonly REGISTRATION_DIALOGUE: RuntimeProbeNamespace;
}

/** Options used to assemble the Worker route tree. */
export interface Options {
  readonly authDependencies: Auth.AuthDependencies;
  readonly config: RuntimeConfig;
  readonly env: Bindings;
  readonly runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>;
}

/** Assemble typed product routes, Better Auth, and Cloudflare host probes. */
export const layer = (options: Options) => {
  const api = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(Handlers.layer(options.runtime)),
  );

  return Layer.mergeAll(
    api,
    Auth.layer({ config: options.config.auth, dependencies: options.authDependencies }),
    HttpRouter.add("GET", "/agents/:identity/health", agentProbe(options.env)),
    HttpRouter.add(
      "GET",
      "/registration-dialogues/:identity/health",
      registrationDialogueProbe(options.env),
    ),
    HttpRouter.add("*", "*", notFound),
  );
};

const agentProbe = (env: Bindings) =>
  HttpRouter.params.pipe(
    Effect.flatMap(({ identity }) =>
      identity === undefined
        ? Effect.succeed(notFound)
        : callProbe("osfo-agent", () => env.OSFO_AGENT.getByName(identity).probeRuntime()),
    ),
  );

const registrationDialogueProbe = (env: Bindings) =>
  HttpRouter.params.pipe(
    Effect.flatMap(({ identity }) =>
      identity === undefined
        ? Effect.succeed(notFound)
        : callProbe("registration-dialogue", () =>
            env.REGISTRATION_DIALOGUE.getByName(identity).probeRuntime(),
          ),
    ),
  );

const callProbe = (
  executionUnit: "osfo-agent" | "registration-dialogue",
  invoke: () => Promise<RuntimeProbeResult>,
) =>
  Effect.tryPromise({
    try: invoke,
    catch: (cause) =>
      new CloudflareHostUnavailable({
        cause,
        executionUnit,
        message: "Cloudflare execution unit is unavailable",
      }),
  }).pipe(
    Effect.map(runtimeProbeResponse),
    Effect.catchTag("CloudflareHostUnavailable", (error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: error.message, executionUnit: error.executionUnit },
          { status: 503 },
        ),
      ),
    ),
  );

const runtimeProbeResponse = (result: RuntimeProbeResult): HttpServerResponse.HttpServerResponse =>
  "kind" in result
    ? HttpServerResponse.jsonUnsafe(result)
    : HttpServerResponse.jsonUnsafe(
        { error: result.message, binding: result.binding },
        { status: 500 },
      );

const notFound = HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 });
