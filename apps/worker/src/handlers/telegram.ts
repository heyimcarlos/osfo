import { Effect, Layer } from "effect";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import type { TelegramConfig } from "../config";
import * as TelegramAdmission from "../services/telegram-message-admission";
import * as Onboarding from "../services/onboarding";
import * as TelegramDelivery from "../services/telegram-onboarding-delivery";
import { handleTelegramWebhook } from "./telegram-webhook";

/** Telegram route configuration. */
export interface Options {
  readonly telegram: TelegramConfig;
}

/** Bind the verified Telegram webhook to onboarding and stable-Agent admission. */
export const layer = (options: Options) =>
  Layer.unwrap(
    Effect.all([Onboarding.Service, TelegramAdmission.Service, TelegramDelivery.Service]).pipe(
      Effect.map(([onboarding, admission, delivery]) => {
        return HttpRouter.add(
          "*",
          "/messengers/telegram/webhook",
          HttpEffect.fromWebHandler((request) =>
            Effect.runPromise(
              Effect.promise(() => import("../integrations/telegram/outbound")).pipe(
                Effect.flatMap((TelegramOutbound) =>
                  handleTelegramWebhook(request, {
                    admission,
                    allowedUserIds: new Set(options.telegram.allowedUserIds),
                    delivery,
                    onboarding,
                    outbound: TelegramOutbound.make({
                      allowedUserIds: options.telegram.allowedUserIds,
                      botToken: options.telegram.botToken,
                      userName: options.telegram.botUsername,
                    }),
                    secretToken: options.telegram.webhookSecret,
                  }),
                ),
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
