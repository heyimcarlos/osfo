import { Effect, Predicate, Schema } from "effect";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

import type { BillingTransactionRetryExhausted, DatabaseUnavailable } from "../domain/allowance";
import { type BillingCheckoutSessionId, StripeCheckoutSessionId } from "../domain";
import { InvalidStripeSnapshot } from "./billing-subscriptions";
import type {
  ApplyStripeSnapshotResult,
  StaleSnapshot,
  StripeCheckoutEvidence,
  StripeCheckoutLocator,
  StripeSubscriptionSnapshot,
} from "./billing-subscriptions";
import type { StripeRequestFailed } from "./stripe-billing";

const supportedEventTypes = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.closed",
  "charge.dispute.funds_reinstated",
]);

/** Signature-verified Stripe event locator with no embedded projection state. */
export interface VerifiedStripeEvent {
  readonly billingCheckoutSessionId: BillingCheckoutSessionId | null;
  readonly decodeErrorCode?: "invalid_stripe_event";
  readonly externalEventId: string;
  readonly externalObjectId: string;
  readonly type: string;
}

/** Expected rejection for an invalid or mutated Stripe signature. */
export class InvalidStripeSignature extends Schema.TaggedError<InvalidStripeSignature>()(
  "InvalidStripeSignature",
  { message: Schema.String },
) {}

/** Expected failure while durable webhook state is unavailable. */
export class WebhookPersistenceUnavailable extends Schema.TaggedError<WebhookPersistenceUnavailable>()(
  "WebhookPersistenceUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Permanent current-state failure that Stripe redelivery cannot repair. */
export class PermanentStripeWebhookFailure extends Schema.TaggedError<PermanentStripeWebhookFailure>()(
  "PermanentStripeWebhookFailure",
  { errorCode: Schema.String, message: Schema.String },
) {}

/** Durable webhook receipt returned after signature verification. */
export type ReceiveResult =
  | { readonly _tag: "ProcessedDuplicate" }
  | { readonly _tag: "Pending"; readonly attempt?: number; readonly webhookEventId: string };

/** Verified stored event returned for an explicit operator replay. */
export interface StoredWebhookEvent extends VerifiedStripeEvent {
  readonly provider: string;
}

/** Durable replay receipt that preserves the original verified locator. */
export type ReplayResult =
  | { readonly _tag: "ProcessedDuplicate" }
  | {
      readonly _tag: "Pending";
      readonly attempt?: number;
      readonly event: StoredWebhookEvent;
      readonly webhookEventId: string;
    };

/** Provider-neutral persistence operations required by webhook processing. */
export interface Persistence {
  readonly fail: (
    webhookEventId: string,
    errorCode: string,
    checkoutEvidence: StripeCheckoutEvidence | null,
  ) => Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable>;
  readonly failClaimed?: (
    webhookEventId: string,
    attempt: number,
    errorCode: string,
    checkoutEvidence: StripeCheckoutEvidence | null,
  ) => Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable>;
  readonly markProcessed: (
    webhookEventId: string,
    checkoutEvidence: StripeCheckoutEvidence | null,
  ) => Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable>;
  readonly markProcessedClaimed?: (
    webhookEventId: string,
    attempt: number,
    checkoutEvidence: StripeCheckoutEvidence | null,
  ) => Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable>;
  readonly receive: (
    event: VerifiedStripeEvent,
  ) => Effect.Effect<ReceiveResult, WebhookPersistenceUnavailable>;
  readonly replay: (
    webhookEventId: string,
  ) => Effect.Effect<ReplayResult, WebhookPersistenceUnavailable>;
}

/** Explicit Stripe boundary for webhook verification and current-object retrieval. */
export interface StripeGateway {
  readonly fetchCurrentSnapshot: (
    event: VerifiedStripeEvent,
  ) => Effect.Effect<
    | { readonly _tag: "NoOp" }
    | { readonly _tag: "Snapshot"; readonly snapshot: StripeSubscriptionSnapshot },
    PermanentStripeWebhookFailure | StripeRequestFailed
  >;
  /** Compatibility-only adapter hook; HTTP uses StripeWebhookTransport directly. */
  readonly verify: (
    rawBody: string,
    signature: string,
  ) => Effect.Effect<VerifiedStripeEvent, InvalidStripeSignature>;
}

/** Signature verification and closed decoding at the Stripe HTTP transport boundary. */
export interface StripeWebhookTransport {
  readonly verifyWebhook: (
    rawBody: string,
    signature: string,
  ) => Effect.Effect<VerifiedStripeEvent, InvalidStripeSignature>;
}

/** Billing projection operation used by verified Stripe events. */
export interface BillingProjection {
  readonly loadRevision: (
    userId: StripeSubscriptionSnapshot["userId"],
  ) => Effect.Effect<Date, BillingTransactionRetryExhausted | DatabaseUnavailable>;
  readonly applyStripeSnapshot: (
    source: { readonly _tag: "Webhook"; readonly attempt: number; readonly webhookEventId: string },
    expectedUpdatedAt: Date,
    snapshot: StripeSubscriptionSnapshot,
    checkoutEvidence: StripeCheckoutEvidence | null,
  ) => Effect.Effect<
    ApplyStripeSnapshotResult | StaleSnapshot,
    BillingTransactionRetryExhausted | DatabaseUnavailable | InvalidStripeSnapshot
  >;
}

type ProjectionError =
  | BillingTransactionRetryExhausted
  | DatabaseUnavailable
  | InvalidStripeSnapshot
  | PermanentStripeWebhookFailure
  | StripeRequestFailed
  | WebhookPersistenceUnavailable;

/** Observable webhook processing acknowledgement. */
export type HandleResult =
  | { readonly _tag: "Processed" }
  | { readonly _tag: "ProcessedDuplicate" }
  | { readonly _tag: "FailedAcknowledged" };

/** Stripe webhook ingestion operation. */
export interface Interface {
  readonly handle: (
    eventOrBody: VerifiedStripeEvent | string,
    signature?: string,
  ) => Effect.Effect<HandleResult, InvalidStripeSignature | ProjectionError>;
  readonly replay: (webhookEventId: string) => Effect.Effect<HandleResult, ProjectionError>;
}

/** Construct durable Stripe webhook ingestion from explicit provider and persistence ports. */
export const make = (options: {
  readonly billing: BillingProjection;
  readonly persistence: Persistence;
  readonly stripe: StripeGateway;
}): Interface => {
  const project = (
    event: VerifiedStripeEvent,
    webhookEventId: string,
    checkoutEvidence: StripeCheckoutEvidence | null,
    projectionAttempt: number,
    webhookAttempt: number,
  ): Effect.Effect<HandleResult, ProjectionError> =>
    Effect.gen(function* () {
      const located = yield* options.stripe.fetchCurrentSnapshot(event);
      if (located._tag === "NoOp") {
        yield* (
          options.persistence.markProcessedClaimed ??
          ((id, _attempt, evidence) => options.persistence.markProcessed(id, evidence))
        )(webhookEventId, webhookAttempt, checkoutEvidence);
        return { _tag: "Processed" } as const;
      }
      const expectedUpdatedAt = yield* options.billing.loadRevision(located.snapshot.userId);
      const current = yield* options.stripe.fetchCurrentSnapshot(event);
      if (current._tag === "NoOp") {
        yield* (
          options.persistence.markProcessedClaimed ??
          ((id, _attempt, evidence) => options.persistence.markProcessed(id, evidence))
        )(webhookEventId, webhookAttempt, checkoutEvidence);
        return { _tag: "Processed" } as const;
      }
      if (current.snapshot.userId !== located.snapshot.userId) {
        return yield* new InvalidStripeSnapshot({
          message: "Stripe webhook identity changed during current-state retrieval",
        });
      }
      const result = yield* options.billing.applyStripeSnapshot(
        { _tag: "Webhook", attempt: webhookAttempt, webhookEventId },
        expectedUpdatedAt,
        current.snapshot,
        checkoutEvidence,
      );
      if (result._tag !== "StaleSnapshot") return { _tag: "Processed" } as const;
      if (projectionAttempt >= 3) {
        return yield* new WebhookPersistenceUnavailable({
          cause: { webhookEventId },
          message: "The billing projection did not converge",
          operation: "applyStripeSnapshot",
        });
      }
      return yield* project(
        event,
        webhookEventId,
        checkoutEvidence,
        projectionAttempt + 1,
        webhookAttempt,
      );
    });

  const checkoutEvidenceFor = (
    event: VerifiedStripeEvent,
  ): Effect.Effect<StripeCheckoutEvidence | null, PermanentStripeWebhookFailure> => {
    const paymentStatus =
      event.type === "checkout.session.async_payment_succeeded"
        ? "paid"
        : event.type === "checkout.session.completed"
          ? "unknown"
          : null;
    if (paymentStatus === null && event.type !== "checkout.session.async_payment_failed") {
      return Effect.succeed(null);
    }
    return Schema.decodeEffect(StripeCheckoutSessionId)(event.externalObjectId).pipe(
      Effect.map((stripeCheckoutSessionId) => {
        const locator: StripeCheckoutLocator =
          event.billingCheckoutSessionId === null
            ? { _tag: "StripeSession", stripeCheckoutSessionId }
            : {
                _tag: "LocalAttempt",
                billingCheckoutSessionId: event.billingCheckoutSessionId,
                stripeCheckoutSessionId,
              };
        return paymentStatus === null
          ? ({
              _tag: "PaymentFailed",
              locator,
            } as const)
          : ({
              _tag: "Completed",
              locator,
              paymentStatus,
            } as const);
      }),
      Effect.mapError(
        () =>
          new PermanentStripeWebhookFailure({
            errorCode: "invalid_checkout_session_id",
            message: "Stripe Checkout event has an invalid Checkout Session identity",
          }),
      ),
    );
  };

  const persistFailure = (
    webhookEventId: string,
    webhookAttempt: number,
    errorCode: string,
    checkoutEvidence: StripeCheckoutEvidence | null,
  ): Effect.Effect<void, WebhookPersistenceUnavailable> =>
    (
      options.persistence.failClaimed ??
      ((id, _attempt, code, evidence) => options.persistence.fail(id, code, evidence))
    )(webhookEventId, webhookAttempt, errorCode, checkoutEvidence).pipe(
      Effect.catchTag("PermanentStripeWebhookFailure", (identityFailure) =>
        (
          options.persistence.failClaimed ??
          ((id, _attempt, code, evidence) => options.persistence.fail(id, code, evidence))
        )(webhookEventId, webhookAttempt, identityFailure.errorCode, null).pipe(
          Effect.catchTag(
            "PermanentStripeWebhookFailure",
            () =>
              new WebhookPersistenceUnavailable({
                cause: identityFailure,
                message: "Webhook failure persistence rejected an empty Checkout evidence set",
                operation: "fail",
              }),
          ),
        ),
      ),
    );

  const processWithEvidence = (
    event: VerifiedStripeEvent,
    webhookEventId: string,
    webhookAttempt: number,
    checkoutEvidence: StripeCheckoutEvidence | null,
  ) => {
    const processing = !supportedEventTypes.has(event.type)
      ? (
          options.persistence.markProcessedClaimed ??
          ((id, _attempt, evidence) => options.persistence.markProcessed(id, evidence))
        )(webhookEventId, webhookAttempt, checkoutEvidence).pipe(
          Effect.as({ _tag: "Processed" } as const),
        )
      : project(event, webhookEventId, checkoutEvidence, 1, webhookAttempt);
    return processing.pipe(
      Effect.catchTags({
        InvalidStripeSnapshot: (failure) =>
          persistFailure(webhookEventId, webhookAttempt, failure._tag, checkoutEvidence).pipe(
            Effect.andThen(
              Effect.logError("Invalid current Stripe billing snapshot").pipe(
                Effect.annotateLogs({
                  eventType: event.type,
                  externalEventId: event.externalEventId,
                  webhookEventId,
                }),
              ),
            ),
            Effect.as({ _tag: "FailedAcknowledged" } as const),
          ),
        PermanentStripeWebhookFailure: (failure) =>
          persistFailure(webhookEventId, webhookAttempt, failure.errorCode, checkoutEvidence).pipe(
            Effect.andThen(
              Effect.logError("Permanent Stripe webhook failure").pipe(
                Effect.annotateLogs({
                  errorCode: failure.errorCode,
                  eventType: event.type,
                  externalEventId: event.externalEventId,
                  webhookEventId,
                }),
              ),
            ),
            Effect.as({ _tag: "FailedAcknowledged" } as const),
          ),
        StripeRequestFailed: (failure) =>
          Effect.gen(function* () {
            if (failure.kind === "transient") return yield* failure;
            yield* persistFailure(
              webhookEventId,
              webhookAttempt,
              failure.operation,
              checkoutEvidence,
            );
            yield* Effect.logError("Permanent Stripe request failure").pipe(
              Effect.annotateLogs({
                eventType: event.type,
                externalEventId: event.externalEventId,
                operation: failure.operation,
                webhookEventId,
              }),
            );
            return { _tag: "FailedAcknowledged" } as const;
          }),
      }),
    );
  };

  const process = (event: VerifiedStripeEvent, webhookEventId: string, webhookAttempt: number) =>
    checkoutEvidenceFor(event).pipe(
      Effect.flatMap((checkoutEvidence) =>
        processWithEvidence(event, webhookEventId, webhookAttempt, checkoutEvidence),
      ),
      Effect.catchTag("PermanentStripeWebhookFailure", (failure) =>
        persistFailure(webhookEventId, webhookAttempt, failure.errorCode, null).pipe(
          Effect.andThen(
            Effect.logError("Permanent Stripe webhook failure").pipe(
              Effect.annotateLogs({
                errorCode: failure.errorCode,
                eventType: event.type,
                externalEventId: event.externalEventId,
                webhookEventId,
              }),
            ),
          ),
          Effect.as({ _tag: "FailedAcknowledged" } as const),
        ),
      ),
    );

  return {
    handle: (eventOrBody: VerifiedStripeEvent | string, signature?: string) =>
      Effect.gen(function* () {
        const event = Predicate.isString(eventOrBody)
          ? yield* options.stripe.verify(eventOrBody, signature ?? "")
          : eventOrBody;
        const receipt = yield* options.persistence.receive(event);
        if (receipt._tag === "ProcessedDuplicate") return receipt;
        const webhookAttempt = receipt.attempt ?? 1;
        if (event.decodeErrorCode === "invalid_stripe_event") {
          yield* persistFailure(
            receipt.webhookEventId,
            webhookAttempt,
            event.decodeErrorCode,
            null,
          );
          yield* Effect.logError("Signed Stripe webhook failed closed decoding").pipe(
            Effect.annotateLogs({
              externalEventId: event.externalEventId,
              webhookEventId: receipt.webhookEventId,
            }),
          );
          return { _tag: "FailedAcknowledged" } as const;
        }
        return yield* process(event, receipt.webhookEventId, webhookAttempt);
      }),
    replay: (webhookEventId) =>
      Effect.gen(function* () {
        const receipt = yield* options.persistence.replay(webhookEventId);
        if (receipt._tag === "ProcessedDuplicate") return receipt;
        if (receipt.event.provider !== "stripe") {
          return yield* new WebhookPersistenceUnavailable({
            cause: { provider: receipt.event.provider, webhookEventId },
            message: "The stored webhook event does not belong to Stripe",
            operation: "replay",
          });
        }
        return yield* process(receipt.event, receipt.webhookEventId, receipt.attempt ?? 1);
      }),
  };
};
