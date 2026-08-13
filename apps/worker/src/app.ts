import { Effect, Layer, Schema, type ManagedRuntime } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as Db from "./db";
import type { OsfoStage } from "./env";
import {
  type ExecutionUnit,
  makeWorkerRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "./layers";

class CloudflareHostUnavailable extends Schema.TaggedError<CloudflareHostUnavailable>()(
  "CloudflareHostUnavailable",
  {
    cause: Schema.Defect(),
    executionUnit: Schema.Literals(["osfo-agent", "registration-dialogue"]),
    message: Schema.String,
  },
) {}

/** Build one request-scoped Effect HTTP application. */
export const make = (env: Env, stage: OsfoStage) => {
  const runtime = makeWorkerRuntime(stage);
  const appLayer = Layer.mergeAll(
    Db.layer({ db: env.DB }),
    HttpRouter.add("GET", "/health", workerProbe(runtime)),
    HttpRouter.add("GET", "/agents/:identity/health", agentProbe(env)),
    HttpRouter.add(
      "GET",
      "/registration-dialogues/:identity/health",
      registrationDialogueProbe(env),
    ),
    HttpRouter.add("*", "*", (request) =>
      Effect.succeed(isTechnicalRoute(request.url) ? methodNotAllowed : notFound),
    ),
  );
  const webHandler = HttpRouter.toWebHandler(appLayer, { disableLogger: true });

  return {
    dispose: () => webHandler.dispose().then(() => runtime.dispose()),
    handler: webHandler.handler,
  };
};

/** Convert an invalid environment result into a technical HTTP response. */
export const environmentErrorResponse = (result: RuntimeProbeResult): Response =>
  HttpServerResponse.toWeb(runtimeProbeResponse(result));

const workerProbe = (runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>) =>
  Effect.promise(() => runtime.runPromise(probeExecutionUnit)).pipe(
    Effect.map(runtimeProbeResponse),
  );

const agentProbe = (env: Env) =>
  HttpRouter.params.pipe(
    Effect.flatMap(({ identity }) =>
      identity === undefined
        ? Effect.succeed(notFound)
        : callProbe("osfo-agent", () => env.OSFO_AGENT.getByName(identity).probeRuntime()),
    ),
  );

const registrationDialogueProbe = (env: Env) =>
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

const methodNotAllowed = HttpServerResponse.jsonUnsafe(
  { error: "Method not allowed" },
  { status: 405 },
);

const isTechnicalRoute = (url: string) => {
  const pathname = new URL(url, "https://osfo.invalid").pathname;
  return (
    pathname === "/health" ||
    /^\/agents\/[^/]+\/health$/.test(pathname) ||
    /^\/registration-dialogues\/[^/]+\/health$/.test(pathname)
  );
};
