import { BrowserCrypto } from "@effect/platform-browser";
import { Effect, Layer } from "effect";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { Db } from "../db";
import type { ChannelLinkId, UserId } from "../domain";
import { wakeUpSenderLayer } from "../integrations/whatsapp";
import { WhatsAppWakeUps } from "../services/whatsapp-wakeups";

/* oxlint-disable eslint/no-underscore-dangle -- Effect/domain variants use the canonical _tag discriminator. */

/** Production Wake-up module with no source adapters until their owning tickets land. */
export const layer = (config: CloudflareConfig) =>
  WhatsAppWakeUps.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.merge(WhatsAppWakeUps.emptySourceAuthorityLayer, wakeUpSenderLayer(config.whatsApp)),
    ),
  );

/** Drain only when deployment attests the exact approved v1 template. */
export const drainScheduled = (env: CloudflareEnv, config: CloudflareConfig) => {
  if (config.whatsApp.wakeUp._tag === "Inactive") return Promise.resolve();
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  return Effect.runPromise(
    Effect.scoped(
      WhatsAppWakeUps.Service.pipe(
        Effect.flatMap((wakeUps) => wakeUps.drainPending()),
        Effect.tap((result) =>
          Effect.logInfo("WhatsApp Wake-up scheduled drain completed").pipe(
            Effect.annotateLogs({
              accepted: result.accepted,
              ambiguous: result.ambiguous,
              canceled: result.canceled,
              rejected: result.rejected,
              templatePolicyVersion: WhatsAppWakeUps.templatePolicyVersion,
            }),
          ),
        ),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scheduled maintenance owns this complete composition.
        Effect.provide(layer(config).pipe(Layer.provide(base))),
      ),
    ),
  ).then(() => undefined);
};

/** Consume a WhatsApp latch inside the already-owned Agent PostgreSQL runtime. */
export const consumeInbound = (
  config: CloudflareConfig,
  input: { readonly channelLinkId: ChannelLinkId; readonly userId: UserId },
) =>
  Effect.scoped(
    WhatsAppWakeUps.Service.pipe(
      Effect.flatMap((wakeUps) => wakeUps.consumeInbound(input)),
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Agent ingress owns the request-local Wake-up policy layer.
      Effect.provide(layer(config)),
    ),
  );

export * as WhatsAppWakeUpComposition from "./whatsapp-wakeups";
