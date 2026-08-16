import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import type * as Auth from "./auth";
import * as Db from "./db";
import type { RuntimeConfig } from "./env";
import * as TwilioVerify from "./integrations/twilio/verify";
import * as OnboardingCloudflare from "./integrations/cloudflare/onboarding";
import * as OnboardingPostgres from "./integrations/postgres/onboarding";
import * as OnboardingLinks from "./integrations/public/onboarding-links";
import { makeWorkerRuntime } from "./layers";
import * as Routes from "./routes";
import * as Onboarding from "./services/onboarding";
import * as Registration from "./services/registration";

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
    Layer.provide(BrowserCrypto.layer),
    Layer.provide(HttpServer.layerServices),
  );
  const webHandler = HttpRouter.toWebHandler(appLayer, { disableLogger: true });

  return {
    dispose: () => webHandler.dispose().then(() => runtime.dispose()),
    handler: webHandler.handler,
  };
};

/** Delete expired Registration Invitation data from the scheduled Worker event. */
export const expireRegistrationInvitations = (env: Bindings, config: RuntimeConfig) =>
  Effect.runPromise(Effect.scoped(runInvitationExpiry(env, config)));

const runInvitationExpiry = (env: Bindings, config: RuntimeConfig) => {
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  const dependencies = Layer.mergeAll(
    Registration.layerWithoutDependencies,
    OnboardingCloudflare.layer(env),
    OnboardingLinks.layer({
      officialWhatsAppNumber: config.whatsApp.phoneNumber,
      publicBaseUrl: new URL(config.auth.baseURL),
    }),
  ).pipe(Layer.provideMerge(base));
  const onboarding = Onboarding.layerWithoutDependencies.pipe(Layer.provide(dependencies));
  const persistence = OnboardingPostgres.layerWithoutDependencies.pipe(Layer.provide(base));
  return Effect.flatMap(Onboarding.Service, (service) => service.expireInvitations).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scheduled maintenance is an application entry point.
    Effect.provide(onboarding.pipe(Layer.provide(persistence))),
  );
};

/** Convert invalid Worker bindings into a safe technical HTTP response. */
export const environmentErrorResponse = (): Response =>
  HttpServerResponse.toWeb(
    HttpServerResponse.jsonUnsafe(
      { error: "The Worker runtime configuration is invalid" },
      { status: 500 },
    ),
  );
