import { Layer, type ManagedRuntime } from "effect";

import { BillingHandlers } from "./handlers/billing";
import { ChannelLinksHandlers } from "./handlers/channel-links";
import { HealthHandlers } from "./handlers/health";
import { RegistrationHandlers } from "./handlers/registration";
import type { ExecutionUnit } from "./layers";
import type { CloudflareConfig } from "./config";

/** Implement every typed Osfo API group. */
export const layer = (
  runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>,
  config: CloudflareConfig,
) =>
  Layer.mergeAll(
    BillingHandlers.layer(config),
    ChannelLinksHandlers.layer,
    HealthHandlers.layer(runtime),
    RegistrationHandlers.layer,
  );

export * as Handlers from "./handlers";
