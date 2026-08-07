import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { seedReferenceClientAuthority } from "@osfo/db/reference-client";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { requireApprovedDatabaseProxy } from "./approved-database-proxy";

const Uuid = Schema.String.check(Schema.isUUID());
const DemoSeedConfig = Config.all({
  authenticationToken: Config.nonEmptyString("OSFO_REFERENCE_AUTHENTICATION_TOKEN"),
  databaseUrl: Config.schema(Schema.URLFromString, "OSFO_DATABASE_URL"),
  threadId: Config.schema(Uuid, "OSFO_REFERENCE_THREAD_ID"),
});

Effect.gen(function* () {
  const config = yield* DemoSeedConfig;
  yield* requireApprovedDatabaseProxy(config.databaseUrl, "demo seed");
  return yield* seedReferenceClientAuthority({
    authenticationToken: config.authenticationToken,
    databaseUrl: config.databaseUrl.toString(),
    threadId: config.threadId,
  });
}).pipe(
  Effect.tap(({ threadId }) =>
    Effect.logInfo("PASS: explicit demo authority seeded", { threadId }),
  ),
  NodeRuntime.runMain,
);
