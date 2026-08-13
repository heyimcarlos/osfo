import { Effect, Schema } from "effect";

import type { ExecutionUnit, RuntimeProbe, RuntimeProbeResult } from "./layers";

class CloudflareHostUnavailable extends Schema.TaggedError<CloudflareHostUnavailable>()(
  "CloudflareHostUnavailable",
  {
    executionUnit: Schema.Literals(["osfo-agent", "registration-dialogue"]),
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** Route one Worker request without owning product policy. */
export const routeRequest = (
  request: Request,
  env: Env,
  workerProbe: Effect.Effect<RuntimeProbe, never, ExecutionUnit>,
): Effect.Effect<Response, never, ExecutionUnit> => {
  const path = new URL(request.url).pathname.split("/").filter(Boolean);

  if (request.method !== "GET") {
    return Effect.succeed(Response.json({ error: "Method not allowed" }, { status: 405 }));
  }

  if (path.length === 1 && path[0] === "health") {
    return workerProbe.pipe(Effect.map(runtimeProbeResponse));
  }

  if (path.length === 3 && path[0] === "agents" && path[2] === "health") {
    const identity = path[1];
    if (identity === undefined) {
      return Effect.succeed(Response.json({ error: "Not found" }, { status: 404 }));
    }
    return callProbe("osfo-agent", () => env.OSFO_AGENT.getByName(identity).probeRuntime());
  }

  if (path.length === 3 && path[0] === "registration-dialogues" && path[2] === "health") {
    const identity = path[1];
    if (identity === undefined) {
      return Effect.succeed(Response.json({ error: "Not found" }, { status: 404 }));
    }
    return callProbe("registration-dialogue", () =>
      env.REGISTRATION_DIALOGUE.getByName(identity).probeRuntime(),
    );
  }

  return Effect.succeed(Response.json({ error: "Not found" }, { status: 404 }));
};

const callProbe = (
  executionUnit: "osfo-agent" | "registration-dialogue",
  invoke: () => Promise<RuntimeProbeResult>,
): Effect.Effect<Response> =>
  Effect.tryPromise({
    try: invoke,
    catch: (cause) =>
      new CloudflareHostUnavailable({
        executionUnit,
        message: "Cloudflare execution unit is unavailable",
        cause,
      }),
  }).pipe(
    Effect.map(runtimeProbeResponse),
    Effect.catchTag("CloudflareHostUnavailable", (error) =>
      Effect.succeed(
        Response.json(
          { error: error.message, executionUnit: error.executionUnit },
          { status: 503 },
        ),
      ),
    ),
  );

/** Convert a runtime probe result into its technical HTTP response. */
export const runtimeProbeResponse = (result: RuntimeProbeResult): Response =>
  "kind" in result
    ? Response.json(result)
    : Response.json({ error: result.message, binding: result.binding }, { status: 500 });
