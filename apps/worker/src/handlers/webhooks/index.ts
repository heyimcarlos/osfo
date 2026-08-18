import { Layer } from "effect";

import type { CloudflareConfig } from "../../config";
import * as Stripe from "./stripe";

/** Bindings used by provider webhook routes. */
export type Bindings = object;

/** Install the canonical webhook route tree for every configured provider. */
export const layer = (options: { readonly config: CloudflareConfig; readonly env: Bindings }) =>
  Layer.mergeAll(Stripe.layer(options.config));
