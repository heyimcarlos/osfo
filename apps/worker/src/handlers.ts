import { Layer, type ManagedRuntime } from "effect";

import { BillingHandlers } from "./handlers/billing";
import { AccountHandlers } from "./handlers/account";
import { ChannelLinksHandlers } from "./handlers/channel-links";
import { HealthHandlers } from "./handlers/health";
import { RegistrationHandlers } from "./handlers/registration";
import type { ExecutionUnit } from "./layers";
import type { CloudflareConfig } from "./config";
import type { AccountDeletionComposition } from "./composition/account-deletion";
import { SupermemoryMemoryProvider } from "./integrations/supermemory/memory-provider";

/** Implement every typed Osfo API group. */
export const layer = (
  runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>,
  config: CloudflareConfig,
  bindings: AccountDeletionComposition.Bindings,
) =>
  Layer.mergeAll(
    AccountHandlers.layer(bindings).pipe(
      Layer.provide(SupermemoryMemoryProvider.layerFromConfig(config.supermemory)),
    ),
    BillingHandlers.layer(config),
    ChannelLinksHandlers.layer,
    HealthHandlers.layer(runtime),
    RegistrationHandlers.layer,
  );

export * as Handlers from "./handlers";
