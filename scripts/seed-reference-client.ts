import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { seedReferenceClientAuthority } from "@osfo/db/reference-client";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Uuid = Schema.String.check(Schema.isUUID());
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

class ReferenceClientSeedRequiresLocalDatabase extends Data.TaggedError(
  "ReferenceClientSeedRequiresLocalDatabase",
)<{ readonly hostname: string }> {}

const ReferenceClientSeedConfig = Config.all({
  authenticationToken: Config.nonEmptyString("VITE_OSFO_AUTHENTICATION_TOKEN"),
  databaseUrl: Config.schema(Schema.URLFromString, "OSFO_DATABASE_URL"),
  threadId: Config.schema(Uuid, "VITE_OSFO_THREAD_ID"),
});

Effect.gen(function* () {
  const config = yield* ReferenceClientSeedConfig;
  if (!loopbackHosts.has(config.databaseUrl.hostname)) {
    return yield* new ReferenceClientSeedRequiresLocalDatabase({
      hostname: config.databaseUrl.hostname,
    });
  }
  return yield* seedReferenceClientAuthority({
    ...config,
    databaseUrl: config.databaseUrl.toString(),
  });
}).pipe(
  Effect.tap(({ threadId }) => Effect.logInfo("Reference Thread authority is ready", { threadId })),
  NodeRuntime.runMain,
);
