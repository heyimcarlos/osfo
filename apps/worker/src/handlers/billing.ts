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
import * as BillingAuthorization from "../composition/billing-authorization";
import * as Db from "../db";
import { findStripeCheckoutSession, findStripeSubscription } from "../db/billing/stripe-inspect";
import {
  AllowancePeriodId,
  StripeCheckoutSessionId,
  StripeSubscriptionId,
  UserId,
} from "../domain";
import type { CloudflareConfig } from "../config";
import type { BillingOperation } from "../services/billing-authorization";
import { reconcileBillingReturn } from "../services/billing-return";
import { StripeStateUnavailable } from "../services/billing-subscriptions";
import { BillingPersistenceUnavailable } from "../services/stripe-billing";

/* oxlint-disable effecttsgo/crypto-random-uuid-in-effect -- The HTTP composition boundary supplies secure persisted identities. */

/** Implement authenticated Stripe billing and reconciliation routes. */
export const layer = (config: CloudflareConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const database = yield* Db.database;
      const authorize = yield* BillingAuthorization.make(database, {
        allowancePeriodId: Effect.sync(() => AllowancePeriodId.make(crypto.randomUUID())),
        now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
      });
      const services = makeBillingServices(database, config);
      return HttpApiBuilder.group(Api, "billing", (handlers) =>
        handlers
          .handle("inspect", () =>
            Effect.gen(function* () {
              const currentUser = yield* CurrentUser;
              yield* requireBillingAuthorization(authorize, currentUser, "billing.inspect");
              return yield* services.presentation
                .inspect(UserId.make(currentUser.userId))
                .pipe(Effect.mapError(toBillingUnavailable));
            }),
          )
          .handle("checkout", () =>
            Effect.gen(function* () {
              const currentUser = yield* CurrentUser;
              yield* requireBillingAuthorization(authorize, currentUser, "subscription.manage");
              const authorizeExternalEffect = requireBillingAuthorization(
                authorize,
                currentUser,
                "subscription.manage",
              ).pipe(
                Effect.mapError(
                  () =>
                    new BillingPersistenceUnavailable({
                      cause: { userId: currentUser.userId },
                      message: "The current billing authorization is unavailable",
                      operation: "authorizeCheckout",
                    }),
                ),
              );
              const checkout = yield* services.stripeBilling
                .startCheckout(UserId.make(currentUser.userId), authorizeExternalEffect)
                .pipe(Effect.mapError(toBillingUnavailable));
              return { url: checkout.url };
            }),
          )
          .handle("portal", () =>
            Effect.gen(function* () {
              const currentUser = yield* CurrentUser;
              yield* requireBillingAuthorization(authorize, currentUser, "subscription.manage");
              const authorizeExternalEffect = requireBillingAuthorization(
                authorize,
                currentUser,
                "subscription.manage",
              ).pipe(
                Effect.mapError(
                  () =>
                    new BillingPersistenceUnavailable({
                      cause: { userId: currentUser.userId },
                      message: "The current billing authorization is unavailable",
                      operation: "authorizePortal",
                    }),
                ),
              );
              const url = yield* services.stripeBilling
                .openPortal(UserId.make(currentUser.userId), authorizeExternalEffect)
                .pipe(Effect.mapError(toBillingUnavailable));
              return { url };
            }),
          )
          .handle("reconcile", ({ payload }) =>
            Effect.gen(function* () {
              const currentUser = yield* CurrentUser;
              const userId = UserId.make(currentUser.userId);
              const input =
                payload.reason === "checkoutReturn"
                  ? {
                      reason: payload.reason,
                      stripeCheckoutSessionId: yield* Schema.decodeEffect(StripeCheckoutSessionId)(
                        payload.stripeCheckoutSessionId,
                      ).pipe(Effect.mapError(toBillingUnavailable)),
                      userId,
                    }
                  : { reason: payload.reason, userId };
              return yield* reconcileBillingReturn(input, {
                authorize: requireBillingAuthorization(
                  authorize,
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
                findCheckoutSession: (requestedUserId, stripeCheckoutSessionId) =>
                  findStripeCheckoutSession(
                    database,
                    requestedUserId,
                    stripeCheckoutSessionId,
                  ).pipe(Effect.mapError(toBillingUnavailable)),
                findStoredSubscription: (requestedUserId) =>
                  findStripeSubscription(database, requestedUserId).pipe(
                    Effect.flatMap((storedSubscriptionId) =>
                      storedSubscriptionId === null
                        ? Effect.succeed(null)
                        : Schema.decodeEffect(StripeSubscriptionId)(storedSubscriptionId),
                    ),
                    Effect.mapError(toBillingUnavailable),
                  ),
                reconcile: (subject, reason, fetch, checkoutEvidence) =>
                  services.subscriptions
                    .reconcile(subject, reason, fetch, checkoutEvidence)
                    .pipe(Effect.mapError(toBillingUnavailable)),
                retrieveCheckout: (checkoutId) =>
                  services.stripe
                    .retrieveCheckoutForReturn(checkoutId)
                    .pipe(Effect.mapError(toBillingUnavailable)),
              }).pipe(Effect.mapError(toBillingUnavailable));
            }),
          ),
      );
    }),
  );

const requireBillingAuthorization = (
  authorize: Effect.Success<ReturnType<typeof BillingAuthorization.make>>,
  currentUser: CurrentUserValue,
  operation: BillingOperation,
) =>
  Effect.gen(function* () {
    if (!(yield* authorize(currentUser, operation).pipe(Effect.mapError(toBillingUnavailable)))) {
      return yield* new BillingForbidden({ message: "This billing operation is not permitted." });
    }
    return undefined;
  });

const toBillingUnavailable = () =>
  new BillingUnavailable({
    message: "Billing is temporarily unavailable. Please try again.",
  });
