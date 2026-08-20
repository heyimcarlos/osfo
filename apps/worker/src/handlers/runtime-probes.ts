import { Effect, Schema } from "effect";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import type { RuntimeProbeResult } from "../layers";

class CloudflareHostUnavailable extends Schema.TaggedError<CloudflareHostUnavailable>()(
  "CloudflareHostUnavailable",
  {
    cause: Schema.Defect(),
    executionUnit: Schema.Literals(["osfo-agent", "registration-dialogue"]),
    message: Schema.String,
  },
) {}

interface DirectoryProbeStub {
  readonly probeAgent: (agentId: string) => Promise<RuntimeProbeResult>;
}

interface RuntimeProbeStub {
  readonly probeRuntime: () => Promise<RuntimeProbeResult>;
}

interface RuntimeProbeNamespace {
  readonly getByName: (identity: string) => RuntimeProbeStub;
}

/** Cloudflare bindings used only by temporary runtime probes. */
export interface Bindings {
  readonly OSFO_DIRECTORY: {
    readonly getByName: (identity: string) => DirectoryProbeStub;
  };
  readonly REGISTRATION_DIALOGUE: RuntimeProbeNamespace;
}

/** Temporary route that probes one named Osfo Agent runtime. */
export const agent = (env: Bindings) =>
  HttpRouter.params.pipe(
    Effect.flatMap(({ identity }) =>
      identity === undefined
        ? Effect.succeed(notFound)
        : call("osfo-agent", () =>
            env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).probeAgent(identity),
          ),
    ),
  );

/** Temporary route that probes one named Registration Dialogue runtime. */
export const registrationDialogue = (env: Bindings) =>
  HttpRouter.params.pipe(
    Effect.flatMap(({ identity }) =>
      identity === undefined
        ? Effect.succeed(notFound)
        : call("registration-dialogue", () =>
            env.REGISTRATION_DIALOGUE.getByName(identity).probeRuntime(),
          ),
    ),
  );

const call = (
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
    Effect.map(response),
    Effect.catchTag("CloudflareHostUnavailable", (error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: error.message, executionUnit: error.executionUnit },
          { status: 503 },
        ),
      ),
    ),
  );

const response = (result: RuntimeProbeResult): HttpServerResponse.HttpServerResponse =>
  "kind" in result
    ? HttpServerResponse.jsonUnsafe(result)
    : HttpServerResponse.jsonUnsafe(
        { error: result.message, binding: result.binding },
        { status: 500 },
      );

const notFound = HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 });

export * as RuntimeProbeHandlers from "./runtime-probes";
