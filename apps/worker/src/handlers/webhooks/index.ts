import { Layer } from "effect";

import type { CloudflareConfig } from "../../config";
import { StripeWebhookHandlers } from "./stripe";

/** Bindings used by provider webhook routes. */
export type Bindings = object;

/** Install the canonical webhook route tree for every configured provider. */
export const layer = (options: { readonly config: CloudflareConfig; readonly env: Bindings }) =>
  Layer.mergeAll(StripeWebhookHandlers.layer(options.config));

export * as WebhookHandlers from "./index";
