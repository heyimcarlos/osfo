import { Api } from "@osfo/api";
import { Effect, Layer, type ManagedRuntime } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import * as Auth from "./auth";
import { productApiLayer } from "./cors";
import type { RuntimeConfig } from "./env";
import * as Handlers from "./handlers";
import * as RuntimeProbes from "./handlers/runtime-probes";
import * as InvitationAuth from "./handlers/invitation-auth";
import * as WhatsApp from "./handlers/whatsapp";
import * as TelegramRoutes from "./handlers/telegram";
import type { ExecutionUnit } from "./layers";
import * as AuthMiddleware from "./middleware/auth";
import * as OnboardingCloudflare from "./integrations/cloudflare/onboarding";
import * as TelegramAdmissionCloudflare from "./integrations/cloudflare/telegram-admission";
import * as TelegramAdmissionPostgres from "./integrations/postgres/telegram-admission";
import * as TelegramDeliveryPostgres from "./integrations/postgres/telegram-onboarding-delivery";
import * as OnboardingPostgres from "./integrations/postgres/onboarding";
import * as OnboardingLinks from "./integrations/public/onboarding-links";
import * as Onboarding from "./services/onboarding";
import * as TelegramAdmission from "./services/telegram-message-admission";
import * as TelegramDelivery from "./services/telegram-onboarding-delivery";
import * as Registration from "./services/registration";
import * as DocumentDownload from "./integrations/cloudflare/document-download";

/** Cloudflare bindings used by the Worker route tree. */
export type Bindings = RuntimeProbes.Bindings &
  OnboardingCloudflare.Bindings &
  TelegramAdmissionCloudflare.Bindings &
  WhatsApp.Bindings & { readonly ARTIFACTS?: R2Bucket };

/** Options used to assemble the Worker route tree. */
export interface Options {
  readonly authDependencies: Auth.AuthDependencies;
  readonly config: RuntimeConfig;
  readonly env: Bindings;
  readonly runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>;
}

/** Assemble typed product routes, Better Auth, and Cloudflare host probes. */
export const layer = (options: Options) => {
  const onboardingLinks = OnboardingLinks.layer({
    enrollmentProvider: options.config.telegram.kind === "enabled" ? "telegram" : "whatsapp",
    officialWhatsAppNumber: options.config.whatsApp.phoneNumber,
    publicBaseUrl: new URL(options.config.auth.baseURL),
    telegramBotUsername:
      options.config.telegram.kind === "enabled" ? options.config.telegram.botUsername : "disabled",
  });
  const api = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(Handlers.layer(options.runtime)),
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
  const whatsapp = WhatsApp.layer({
    config: options.config,
    env: options.env,
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
  const telegramAdmission = TelegramAdmission.layerWithoutDependencies.pipe(
    Layer.provide(TelegramAdmissionPostgres.layerWithoutDependencies),
    Layer.provide(TelegramAdmissionCloudflare.layer(options.env)),
    Layer.provide(options.authDependencies),
  );
  const telegramInvitationPersistence = Layer.effect(
    TelegramDelivery.InvitationPersistence,
    Onboarding.Persistence.pipe(
      Effect.map((persistence) =>
        TelegramDelivery.InvitationPersistence.of({
          expireLive: persistence.expireLive,
          findLiveChannel: (channelIdentity) =>
            persistence.findLiveChannel("telegram", channelIdentity),
        }),
      ),
    ),
  ).pipe(Layer.provide(OnboardingPostgres.layerWithoutDependencies));
  const telegramDelivery = TelegramDelivery.layerWithoutDependencies.pipe(
    Layer.provide(TelegramDeliveryPostgres.layerWithoutDependencies),
    Layer.provide(telegramInvitationPersistence),
    Layer.provide(OnboardingCloudflare.layer(options.env)),
    Layer.provide(onboardingLinks),
    Layer.provide(options.authDependencies),
  );
  const telegram =
    options.config.telegram.kind === "enabled"
      ? TelegramRoutes.layer({
          stage: options.config.stage,
          telegram: options.config.telegram,
        }).pipe(
          Layer.provide(onboardingRequest),
          Layer.provide(telegramAdmission),
          Layer.provide(telegramDelivery),
        )
      : Layer.empty;

  return Layer.mergeAll(
    api,
    invitationAuth,
    whatsapp,
    documentDownload,
    telegram,
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
