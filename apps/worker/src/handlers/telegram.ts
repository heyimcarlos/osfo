import { Effect, Layer } from "effect";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import type { OsfoStage, RuntimeConfig } from "../env";
import * as TelegramAdmission from "../services/telegram-message-admission";
import * as Onboarding from "../services/onboarding";
import * as TelegramDelivery from "../services/telegram-onboarding-delivery";
import { handleTelegramWebhook } from "./telegram-webhook";

/** Telegram route configuration after runtime decoding and production rejection. */
export interface Options {
  readonly stage: OsfoStage;
  readonly telegram: Extract<RuntimeConfig["telegram"], { readonly kind: "enabled" }>;
}

/** Bind the verified Telegram webhook to onboarding and stable-Agent admission. */
export const layer = (options: Options) =>
  Layer.unwrap(
    Effect.all([
      Onboarding.Service,
      TelegramAdmission.Service,
      TelegramDelivery.Service,
      Effect.promise(() => import("../integrations/telegram/outbound")),
    ]).pipe(
      Effect.map(([onboarding, admission, delivery, TelegramOutbound]) => {
        const outbound = TelegramOutbound.make({
          allowedUserIds: options.telegram.allowedUserIds,
          botToken: options.telegram.botToken,
          userName: options.telegram.botUsername,
        });
        return HttpRouter.add(
          "*",
          "/messengers/telegram/webhook",
          HttpEffect.fromWebHandler((request) =>
            Effect.runPromise(
              handleTelegramWebhook(request, {
                admission,
                allowedUserIds: new Set(options.telegram.allowedUserIds),
                delivery,
                onboarding,
                outbound,
                secretToken: options.telegram.webhookSecret,
                stage: options.stage,
              }).pipe(
                Effect.match({
                  onFailure: () =>
                    new Response("Telegram webhook is temporarily unavailable", { status: 503 }),
                  onSuccess: (response) => response,
                }),
              ),
            ),
          ),
        );
      }),
    ),
  ).pipe(Layer.provide(BrowserCrypto.layer));
