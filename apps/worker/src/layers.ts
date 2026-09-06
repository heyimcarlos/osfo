import { Layer, ManagedRuntime, Schema } from "effect";
import { BrowserCrypto } from "@effect/platform-browser";

import { Db } from "./db";
import type { SupermemoryConfig } from "./config";
import { SupermemoryMemoryProvider } from "./integrations/supermemory/memory-provider";
import { Capabilities } from "./services/capabilities";

/** Safe environment failure returned by a Cloudflare host boundary. */
export class InvalidOsfoEnvironment extends Schema.TaggedError<InvalidOsfoEnvironment>()(
  "InvalidOsfoEnvironment",
  {
    binding: Schema.Literal("OSFO_STAGE"),
    message: Schema.String,
  },
) {}

/** Safe result for an invalid Osfo stage binding. */
export const invalidOsfoEnvironment = new InvalidOsfoEnvironment({
  binding: "OSFO_STAGE",
  message: "OSFO_STAGE must name a supported deployment stage",
});

/** Create an activation-scoped Osfo Agent runtime. */
export const makeOsfoAgentRuntime = (database: Db.Options, supermemory: SupermemoryConfig) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Db.layer(database),
      BrowserCrypto.layer,
      Capabilities.layer,
      SupermemoryMemoryProvider.layerFromConfig(supermemory, database.db),
    ),
  );
