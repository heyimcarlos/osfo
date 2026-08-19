import { Api } from "@osfo/api";
import { Effect, Layer, type ManagedRuntime } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import * as Auth from "./auth";
import { productApiLayer } from "./cors";
import { publicWebBaseUrl, type CloudflareConfig } from "./config";
import * as Handlers from "./handlers";
import * as RuntimeProbes from "./handlers/runtime-probes";
import * as InvitationAuth from "./handlers/invitation-auth";
import * as Webhooks from "./handlers/webhooks";
import type { ExecutionUnit } from "./layers";
import * as AuthMiddleware from "./middleware/auth";
import * as OnboardingCloudflare from "./integrations/cloudflare/onboarding";
import * as OnboardingPostgres from "./integrations/postgres/onboarding";
import * as OnboardingLinks from "./integrations/public/onboarding-links";
import * as Onboarding from "./services/onboarding";
import * as Registration from "./services/registration";
import * as DocumentDownload from "./integrations/cloudflare/document-download";
import * as AgentDirectory from "./services/agent-directory";
import { UserId } from "./domain";

/** Cloudflare bindings used by the Worker route tree. */
export type Bindings = RuntimeProbes.Bindings &
  OnboardingCloudflare.Bindings &
  Webhooks.Bindings & {
    readonly ARTIFACTS?: R2Bucket;
    readonly routeOsfoAgentRequest: (
      request: Request,
      agentId: string,
      childPath: string,
    ) => Promise<Response>;
  };

/** Options used to assemble the Worker route tree. */
export interface Options {
  readonly authDependencies: Auth.AuthDependencies;
  readonly config: CloudflareConfig;
  readonly env: Bindings;
  readonly runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>;
}

/** Assemble typed product routes, Better Auth, and Cloudflare host probes. */
export const layer = (options: Options) => {
  const onboardingLinks = OnboardingLinks.layer({
    enrollmentProvider: "telegram",
    officialWhatsAppNumber: options.config.whatsApp.publicPhoneNumber,
    publicBaseUrl: publicWebBaseUrl(options.config.auth),
    telegramBotUsername: options.config.telegram.botUsername,
  });
  const api = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(Handlers.layer(options.runtime, options.config)),
    Layer.provide(Onboarding.layerWithoutDependencies),
    Layer.provide(OnboardingPostgres.layerWithoutDependencies),
    Layer.provide(onboardingLinks),
    Layer.provide(Registration.layerWithoutDependencies),
    Layer.provide(OnboardingCloudflare.layer(options.env)),
    Layer.provide(AuthMiddleware.layer(options.config.auth)),
    Layer.provide(productApiLayer(options.config.auth.trustedOrigins)),
    Layer.provide(options.authDependencies),
  );
  const onboardingRequest = Onboarding.layerWithoutDependencies.pipe(
    Layer.provide(OnboardingPostgres.layerWithoutDependencies),
    Layer.provide(Registration.layerWithoutDependencies),
    Layer.provide(OnboardingCloudflare.layer(options.env)),
    Layer.provide(onboardingLinks),
    Layer.provide(options.authDependencies),
  );
  const invitationAuth = InvitationAuth.layer({
    config: options.config.auth,
  }).pipe(HttpRouter.provideRequest(Layer.merge(onboardingRequest, options.authDependencies)));
  const documentDownload =
    options.env.ARTIFACTS === undefined
      ? Layer.empty
      : HttpRouter.add(
          "GET",
          "/documents/export",
          DocumentDownload.serve(
            options.env.ARTIFACTS,
            AuthMiddleware.currentDownloadUser(options.config.auth),
          ),
        ).pipe(HttpRouter.provideRequest(options.authDependencies));
  const webhookRequest = Layer.mergeAll(onboardingRequest, options.authDependencies);
  const webhooks = Webhooks.layer({
    config: options.config,
    env: options.env,
  }).pipe(HttpRouter.provideRequest(webhookRequest));
  const webAgent = HttpRouter.add(
    "*",
    "/agent/*",
    Effect.gen(function* () {
      const user = yield* AuthMiddleware.currentUser(options.config.auth);
      const directory = yield* AgentDirectory.make;
      const route = yield* directory.resolve(UserId.make(user.userId));
      const request = yield* HttpServerRequest.HttpServerRequest;
      const source = request.source;
      if (!(source instanceof Request)) return HttpServerResponse.empty({ status: 503 });
      const childPath = new URL(source.url).pathname.slice("/agent".length) || "/";
      const response = yield* Effect.promise(() =>
        options.env.routeOsfoAgentRequest(source, route.agentId, childPath),
      );
      return HttpServerResponse.fromWeb(response);
    }).pipe(
      Effect.catchTags({
        AgentRouteNotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        AuthenticationUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        DbUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        Unauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
      }),
    ),
  ).pipe(HttpRouter.provideRequest(options.authDependencies));

  return Layer.mergeAll(
    api,
    invitationAuth,
    webhooks,
    webAgent,
    documentDownload,
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
