import { Option } from "effect";

import type { CloudflareConfig } from "../config";
import { ComposioPersistence } from "../integrations/composio/persistence";
import { ComposioProvider } from "../integrations/composio/provider";
import { Integrations } from "../services/integrations";

/** Compose production Integrations only when the ignored Composio secret is available. */
export const make = (
  config: Pick<CloudflareConfig, "composio">,
  storage: DurableObjectStorage,
): Option.Option<Integrations.Interface> =>
  config.composio === null
    ? Option.none()
    : Option.some(
        Integrations.make({
          ...ComposioPersistence.make(storage),
          ...ComposioProvider.make(config.composio.apiKey),
        }),
      );

export * as IntegrationComposition from "./integrations";
