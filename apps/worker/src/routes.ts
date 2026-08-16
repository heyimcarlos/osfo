import { Api } from "@osfo/api";
import { Layer, type ManagedRuntime } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import * as Auth from "./auth";
import { productApiLayer } from "./cors";
import type { RuntimeConfig } from "./env";
import * as Handlers from "./handlers";
import * as RuntimeProbes from "./handlers/runtime-probes";
import type { ExecutionUnit } from "./layers";
import * as AuthMiddleware from "./middleware/auth";
import * as Registration from "./services/registration";

/** Cloudflare bindings used by the Worker route tree. */
export type Bindings = RuntimeProbes.Bindings;

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
    Layer.provide(Registration.layerWithoutDependencies),
    Layer.provide(AuthMiddleware.layer(options.config.auth)),
    Layer.provide(productApiLayer(options.config.auth.trustedOrigins)),
    Layer.provide(options.authDependencies),
  );

  return Layer.mergeAll(
    api,
    Auth.layer({
      config: options.config.auth,
      dependencies: options.authDependencies,
    }),
    HttpRouter.add("GET", "/agents/:identity/health", RuntimeProbes.agent(options.env)),
    HttpRouter.add(
      "GET",
      "/registration-dialogues/:identity/health",
      RuntimeProbes.registrationDialogue(options.env),
    ),
    HttpRouter.add("*", "*", notFound),
  );
};

const notFound = HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 });
