import { Api } from "@osfo/api";
import { Effect, Layer, type ManagedRuntime } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { WorkerAuth } from "./auth";
import { productApiLayer } from "./cors";
import type { CloudflareConfig } from "./config";
import { Handlers } from "./handlers";
import { WebhookHandlers } from "./handlers/webhooks";
import type { ExecutionUnit } from "./layers";
import { AuthMiddleware } from "./middleware/auth";
import { RegistrationCloudflare } from "./integrations/cloudflare/registration";
import { Registration } from "./services/registration";
import { DocumentDownload } from "./integrations/cloudflare/document-download";
import { AgentDirectory } from "./services/agent-directory";
import { UserId } from "./domain";
import { ChannelLinks } from "./services/channel-links";
import type { AccountDeletionComposition } from "./composition/account-deletion";
import { ResearchReportComposition } from "./composition/research-report";
import { DocumentBuildComposition } from "./composition/document-build";
import type { SkillsHandlers } from "./handlers/skills";
import type { IntegrationHandlers } from "./handlers/integrations";
import type { FilesHandlers } from "./handlers/files";
import type { ScheduledEmailHandlers } from "./handlers/scheduled-emails";
import { ScheduledEmailComposition } from "./composition/scheduled-email";

/** Cloudflare bindings used by the Worker route tree. */
export type Bindings = AccountDeletionComposition.Bindings &
  RegistrationCloudflare.Bindings &
  SkillsHandlers.Bindings &
  IntegrationHandlers.Bindings &
  ScheduledEmailHandlers.Bindings &
  FilesHandlers.Bindings &
  WebhookHandlers.Bindings & {
    readonly ARTIFACTS?: R2Bucket;
    readonly routeOsfoAgentRequest: (
      request: Request,
      agentId: string,
      childPath: string,
    ) => Promise<Response>;
  };

/** Options used to assemble the Worker route tree. */
export interface Options {
  readonly authDependencies: WorkerAuth.AuthDependencies;
  readonly config: CloudflareConfig;
  readonly env: Bindings;
  readonly runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>;
}

/** Assemble typed product routes, Better Auth, and Cloudflare host probes. */
export const layer = (options: Options) => {
  const api = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(Handlers.layer(options.runtime, options.config, options.env)),
    Layer.provide(
      ResearchReportComposition.followUpLayer.pipe(Layer.provide(options.authDependencies)),
    ),
    Layer.provide(
      DocumentBuildComposition.followUpLayer.pipe(Layer.provide(options.authDependencies)),
    ),
    Layer.provide(
      ScheduledEmailComposition.followUpLayer.pipe(Layer.provide(options.authDependencies)),
    ),
    Layer.provide(ChannelLinks.layerFromConfig(options.config)),
    Layer.provide(Registration.layerWithoutDependencies(options.config.auth.secret)),
    Layer.provide(RegistrationCloudflare.layer(options.env)),
    Layer.provide(AuthMiddleware.layer(options.config.auth)),
    Layer.provide(AuthMiddleware.accountDeletionLayer(options.config.auth)),
    Layer.provide(productApiLayer(options.config.auth.trustedOrigins)),
    Layer.provide(options.authDependencies),
  );
  const documentDownload =
    options.env.ARTIFACTS === undefined
      ? Layer.empty
      : HttpRouter.add(
          "GET",
          "/documents/export",
          DocumentDownload.serve(
            options.env.ARTIFACTS,
            AuthMiddleware.currentDownloadUser(options.config.auth),
            "document",
          ),
        ).pipe(HttpRouter.provideRequest(options.authDependencies));
  const artifactDownload =
    options.env.ARTIFACTS === undefined
      ? Layer.empty
      : HttpRouter.add(
          "GET",
          "/artifacts/export",
          DocumentDownload.serve(
            options.env.ARTIFACTS,
            AuthMiddleware.currentDownloadUser(options.config.auth),
            "artifact",
          ),
        ).pipe(HttpRouter.provideRequest(options.authDependencies));
  const webhooks = WebhookHandlers.layer({
    config: options.config,
    env: options.env,
  }).pipe(HttpRouter.provideRequest(options.authDependencies));
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
    artifactDownload,
    webhooks,
    webAgent,
    documentDownload,
    WorkerAuth.layer({
      config: options.config.auth,
      dependencies: options.authDependencies,
    }),
    HttpRouter.add("*", "*", notFound),
  );
};

const notFound = HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 });

export * as Routes from "./routes";
