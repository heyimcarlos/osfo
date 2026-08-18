import { Layer } from "effect";

import type { CloudflareConfig } from "../../config";
import * as Stripe from "./stripe";
import * as WhatsApp from "./whatsapp";

/** Bindings used by provider webhook routes. */
export type Bindings = WhatsApp.Bindings;

/** Install the canonical webhook route tree for every configured provider. */
export const layer = (options: { readonly config: CloudflareConfig; readonly env: Bindings }) =>
  Layer.mergeAll(Stripe.layer(options.config), WhatsApp.layer(options));
