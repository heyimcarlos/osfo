import { Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import type * as Auth from "./auth";
import * as Db from "./db";
import type { RuntimeConfig } from "./env";
import * as TwilioVerify from "./integrations/twilio/verify";
import { makeWorkerRuntime } from "./layers";
import * as Routes from "./routes";

/** Cloudflare bindings used by the Worker HTTP application. */
export interface Bindings {
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly OSFO_AGENT: Routes.Bindings["OSFO_AGENT"];
  readonly REGISTRATION_DIALOGUE: Routes.Bindings["REGISTRATION_DIALOGUE"];
}

/** Optional concrete dependency choices for application composition. */
export interface MakeOptions {
  readonly authDependencies?: Auth.AuthDependencies;
}

/** Build one request-scoped Effect HTTP application. */
export const make = (env: Bindings, config: RuntimeConfig, options?: MakeOptions) => {
  const runtime = makeWorkerRuntime(config.stage);
  const authDependencies =
    options?.authDependencies ??
    Layer.merge(Db.layer({ db: env.DB }), TwilioVerify.layer(config.twilioVerify));
  const appLayer = Routes.layer({ authDependencies, config, env, runtime }).pipe(
    Layer.provide(HttpServer.layerServices),
  );
  const webHandler = HttpRouter.toWebHandler(appLayer, { disableLogger: true });

  return {
    dispose: () => webHandler.dispose().then(() => runtime.dispose()),
    handler: webHandler.handler,
  };
};

/** Convert invalid Worker bindings into a safe technical HTTP response. */
export const environmentErrorResponse = (): Response =>
  HttpServerResponse.toWeb(
    HttpServerResponse.jsonUnsafe(
      { error: "The Worker runtime configuration is invalid" },
      { status: 500 },
    ),
  );
