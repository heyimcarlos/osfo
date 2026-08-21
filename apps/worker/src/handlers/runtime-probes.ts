import { Effect, Schema } from "effect";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import type { RuntimeProbeResult } from "../layers";

class CloudflareHostUnavailable extends Schema.TaggedError<CloudflareHostUnavailable>()(
  "CloudflareHostUnavailable",
  {
    cause: Schema.Defect(),
    executionUnit: Schema.Literal("osfo-agent"),
    message: Schema.String,
  },
) {}

interface DirectoryProbeStub {
  readonly probeAgent: (agentId: string) => Promise<RuntimeProbeResult>;
}

/** Cloudflare bindings used only by temporary runtime probes. */
export interface Bindings {
  readonly OSFO_DIRECTORY: {
    readonly getByName: (identity: string) => DirectoryProbeStub;
  };
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

const call = (executionUnit: "osfo-agent", invoke: () => Promise<RuntimeProbeResult>) =>
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
