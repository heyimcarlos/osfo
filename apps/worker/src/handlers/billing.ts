import {
  Api,
  BillingForbidden,
  BillingUnavailable,
  CurrentUser,
  type CurrentUserValue,
} from "@osfo/api";
import { DateTime, Effect, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

import { makeBillingServices } from "../billing-composition";
import * as Db from "../db";
import {
  findStripeCheckoutSession,
  findStripeSubscription,
  inspectBillingAuthorization,
} from "../db/billing/stripe-inspect";
import { StripeCheckoutSessionId, StripeSubscriptionId, UserId } from "../domain";
import type { RuntimeConfig } from "../env";
import {
  admit as admitBillingOperation,
  type BillingOperation,
} from "../services/billing-authorization";
import { reconcileBillingReturn } from "../services/billing-return";
import { StripeStateUnavailable } from "../services/billing-subscriptions";

/** Implement authenticated Stripe billing and reconciliation routes. */
export const layer = (config: RuntimeConfig) =>
  Layer.unwrap(
    Effect.map(Db.database, (database) => {
      const services = makeBillingServices(database, config);
      return HttpApiBuilder.group(Api, "billing", (handlers) =>
        handlers
          .handle("inspect", () =>
            Effect.gen(function* () {
              const currentUser = yield* CurrentUser;
              yield* requireBillingAuthorization(database, currentUser, "billing.inspect");
              return yield* services.presentation
                .inspect(UserId.make(currentUser.userId))
                .pipe(Effect.mapError(toBillingUnavailable));
            }),
          )
          .handle("checkout", () =>
            Effect.gen(function* () {
              const currentUser = yield* CurrentUser;
              yield* requireBillingAuthorization(database, currentUser, "subscription.manage");
              const checkout = yield* services.stripeBilling
                .startCheckout(UserId.make(currentUser.userId))
                .pipe(Effect.mapError(toBillingUnavailable));
              return { url: checkout.url };
            }),
          )
          .handle("portal", () =>
            Effect.gen(function* () {
              const currentUser = yield* CurrentUser;
              yield* requireBillingAuthorization(database, currentUser, "subscription.manage");
              const url = yield* services.stripeBilling
                .openPortal(UserId.make(currentUser.userId))
                .pipe(Effect.mapError(toBillingUnavailable));
              return { url };
            }),
          )
          .handle("reconcile", ({ payload }) =>
            Effect.gen(function* () {
              const currentUser = yield* CurrentUser;
              const userId = UserId.make(currentUser.userId);
              return yield* reconcileBillingReturn(
                { reason: payload.reason, userId },
                {
                  authorize: requireBillingAuthorization(
                    database,
                    currentUser,
                    "subscription.manage",
                  ),
                  fetchSubscription: (subscriptionId) =>
                    services.stripe.fetchSubscription(subscriptionId).pipe(
                      Effect.mapError(
                        (failure) =>
                          new StripeStateUnavailable({
                            cause: failure,
                            message: "Current Stripe state is unavailable",
                          }),
                      ),
                    ),
                  findCheckoutSession: (requestedUserId) =>
                    findStripeCheckoutSession(database, requestedUserId).pipe(
                      Effect.flatMap((storedCheckoutId) =>
                        storedCheckoutId === null
                          ? Effect.succeed(null)
                          : Schema.decodeEffect(StripeCheckoutSessionId)(storedCheckoutId),
                      ),
                      Effect.mapError(toBillingUnavailable),
                    ),
                  findStoredSubscription: (requestedUserId) =>
                    findStripeSubscription(database, requestedUserId).pipe(
                      Effect.flatMap((storedSubscriptionId) =>
                        storedSubscriptionId === null
                          ? Effect.succeed(null)
                          : Schema.decodeEffect(StripeSubscriptionId)(storedSubscriptionId),
                      ),
                      Effect.mapError(toBillingUnavailable),
                    ),
                  reconcile: (subject, reason, fetch) =>
                    services.subscriptions
                      .reconcile(subject, reason, fetch)
                      .pipe(Effect.mapError(toBillingUnavailable)),
                  retrieveCheckout: (checkoutId) =>
                    services.stripe
                      .retrieveCheckout(checkoutId)
                      .pipe(Effect.mapError(toBillingUnavailable)),
                },
              );
            }),
          ),
      );
    }),
  );

const requireBillingAuthorization = (
  database: Parameters<typeof inspectBillingAuthorization>[0],
  currentUser: CurrentUserValue,
  operation: BillingOperation,
) =>
  Effect.gen(function* () {
    const userId = UserId.make(currentUser.userId);
    const subscription = yield* inspectBillingAuthorization(database, userId).pipe(
      Effect.mapError(toBillingUnavailable),
    );
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    if (
      !admitBillingOperation(
        {
          authSessionExpiresAt: currentUser.authSessionExpiresAt,
          authSessionId: currentUser.authSessionId,
          ...subscription,
          userId,
        },
        operation,
        now,
      )
    ) {
      return yield* new BillingForbidden({ message: "This billing operation is not permitted." });
    }
    return undefined;
  });

const toBillingUnavailable = () =>
  new BillingUnavailable({
    message: "Billing is temporarily unavailable. Please try again.",
  });
