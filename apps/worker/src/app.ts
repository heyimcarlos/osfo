import { BrowserCrypto } from "@effect/platform-browser";
import { Effect, Layer, Schema, type ManagedRuntime } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import type { AuthDependencies } from "./auth";
import { loadConfig, publicWebBaseUrl, type CloudflareConfig, type CloudflareEnv } from "./config";
import { Db } from "./db";
import { TwilioVerify } from "./integrations/twilio/verify";
import { OnboardingCloudflare } from "./integrations/cloudflare/onboarding";
import { OnboardingPostgres } from "./services/onboarding/postgres";
import { OnboardingLinksAdapter } from "./integrations/public/onboarding-links";
import { makeWorkerRuntime, type ExecutionUnit, RuntimeProbeResult } from "./layers";
import { Routes } from "./routes";
import { Onboarding } from "./services/onboarding";
import { Registration } from "./services/registration";
import { OSFO_DIRECTORY_NAME } from "./agents/osfo/identity";

/* oxlint-disable effecttsgo/async-function -- Cloudflare RPC adapters expose Promise-based interfaces. */

/** Cloudflare bindings used by the Worker HTTP application. */
export interface Bindings {
  readonly ARTIFACTS?: R2Bucket;
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly OSFO_DIRECTORY: Routes.Bindings["OSFO_DIRECTORY"];
  readonly routeOsfoAgentRequest: Routes.Bindings["routeOsfoAgentRequest"];
  readonly REGISTRATION_DIALOGUE: Routes.Bindings["REGISTRATION_DIALOGUE"];
}

/** Optional concrete dependency choices for application composition. */
export interface MakeOptions {
  readonly authDependencies?: AuthDependencies;
}

const AgentRpcTag = Schema.Struct({ _tag: Schema.String });

/** Build one request-scoped Cloudflare application from the current bindings. */
export const makeCloudflareApp = async (env: CloudflareEnv) => {
  const config = loadConfig(env);
  const runtime = makeWorkerRuntime(config.stage);
  const webHandler = makeWebHandler(adaptBindings(env), config, runtime);

  return {
    dispose: () => webHandler.dispose().then(() => runtime.dispose()),
    handler: webHandler.handler,
  };
};

/** Build one request-scoped Effect HTTP application. */
export const make = (env: Bindings, config: CloudflareConfig, options?: MakeOptions) => {
  const runtime = makeWorkerRuntime(config.stage);
  const webHandler = makeWebHandler(env, config, runtime, options);

  return {
    dispose: () => webHandler.dispose().then(() => runtime.dispose()),
    handler: webHandler.handler,
  };
};

const makeWebHandler = (
  env: Bindings,
  config: CloudflareConfig,
  runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>,
  options?: MakeOptions,
) => {
  const authDependencies =
    options?.authDependencies ??
    Layer.merge(Db.layer({ db: env.DB }), TwilioVerify.layer(config.twilioVerify));
  const appLayer = Routes.layer({
    authDependencies,
    config,
    env,
    runtime,
  }).pipe(Layer.provide(BrowserCrypto.layer), Layer.provide(HttpServer.layerServices));
  return HttpRouter.toWebHandler(appLayer, { disableLogger: true });
};

/** Delete expired Registration Invitation data from the scheduled Worker event. */
export const expireRegistrationInvitations = (env: CloudflareEnv, config: CloudflareConfig) =>
  Effect.runPromise(Effect.scoped(runInvitationExpiry(adaptBindings(env), config)));

const runInvitationExpiry = (env: Bindings, config: CloudflareConfig) => {
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  const dependencies = Layer.mergeAll(
    Registration.layerWithoutDependencies,
    OnboardingCloudflare.layer(env),
    OnboardingLinksAdapter.layer({
      officialWhatsAppNumber: config.whatsApp.publicPhoneNumber,
      publicBaseUrl: publicWebBaseUrl(config.auth),
      telegramBotUsername: config.telegram.botUsername,
    }),
  ).pipe(Layer.provideMerge(base));
  const onboarding = OnboardingPostgres.layer.pipe(Layer.provide(dependencies));
  return Effect.flatMap(Onboarding.Service, (service) => service.expireInvitations).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scheduled maintenance is an application entry point.
    Effect.provide(onboarding),
  );
};

const adaptBindings = (env: CloudflareEnv): Bindings => ({
  ARTIFACTS: env.ARTIFACTS,
  DB: env.DB,
  OSFO_DIRECTORY: {
    getByName: () => {
      const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
      return {
        commitAgentWelcome: async (agentId, input) =>
          Schema.decodePromise(AgentRpcTag)(await directory.commitAgentWelcome(agentId, input)),
        ensureAgent: async (agentId) => {
          const identity = await directory.ensureAgent(agentId);
          return { className: identity.className, name: identity.name };
        },
        initializeAgent: async (agentId, input) =>
          Schema.decodePromise(AgentRpcTag)(await directory.initializeAgent(agentId, input)),
        probeAgent: async (agentId) =>
          Schema.decodeSync(RuntimeProbeResult)(await directory.probeAgent(agentId)),
      };
    },
  },
  routeOsfoAgentRequest: async (request, agentId, childPath) => {
    const { camelCaseToKebabCase, routeSubAgentRequest } = await import("agents");
    const { OsfoAgent } = await import("./agents/osfo/agent");
    const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
    const segment = camelCaseToKebabCase(OsfoAgent.name);
    return routeSubAgentRequest(request, directory, {
      fromPath: `/sub/${segment}/${agentId}${childPath}`,
    });
  },
  REGISTRATION_DIALOGUE: {
    getByName: (identity) => {
      const dialogue = async () => env.REGISTRATION_DIALOGUE.getByName(identity);
      return {
        deleteDialogue: async () => {
          const agent = await dialogue();
          await agent.deleteDialogue();
        },
        probeRuntime: async () => {
          const agent = await dialogue();
          return Schema.decodePromise(RuntimeProbeResult)(await agent.probeRuntime());
        },
      };
    },
  },
});

export * as App from "./app";
