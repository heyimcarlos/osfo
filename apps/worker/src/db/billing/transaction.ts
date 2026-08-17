import { Data, Effect, Result, Schema } from "effect";

import {
  type BillingDatabaseOperation,
  BillingTransactionRetryExhausted,
  DatabaseUnavailable,
} from "../../domain/allowance";

const PostgresFailure = Schema.Struct({ code: Schema.optionalKey(Schema.String) });

class BillingTransactionAttemptFailed extends Data.TaggedError("BillingTransactionAttemptFailed")<{
  readonly cause: unknown;
  readonly retryable: boolean;
}> {}

/** Run one short PostgreSQL billing transaction with bounded technical retries. */
export const runBillingTransaction = <A>(
  operation: BillingDatabaseOperation,
  transaction: () => Promise<A>,
) => attempt(operation, transaction, 1);

const attempt = <A>(
  operation: BillingDatabaseOperation,
  transaction: () => Promise<A>,
  attemptNumber: number,
): Effect.Effect<A, BillingTransactionRetryExhausted | DatabaseUnavailable> =>
  Effect.tryPromise({
    try: transaction,
    catch: (cause) => {
      const parsed = Schema.decodeUnknownResult(PostgresFailure)(cause);
      const code = Result.isSuccess(parsed) ? parsed.success.code : undefined;
      return new BillingTransactionAttemptFailed({
        cause,
        retryable: code === "40001" || code === "40P01",
      });
    },
  }).pipe(
    Effect.catchTag("BillingTransactionAttemptFailed", (failure) => {
      if (failure.retryable && attemptNumber < 3) {
        return attempt(operation, transaction, attemptNumber + 1);
      }
      return failure.retryable
        ? Effect.fail(
            new BillingTransactionRetryExhausted({
              attempts: attemptNumber,
              cause: failure.cause,
              message: "PostgreSQL exhausted safe billing transaction retries",
              operation,
            }),
          )
        : Effect.fail(
            new DatabaseUnavailable({
              cause: failure.cause,
              message: "PostgreSQL could not complete the billing transaction",
              operation,
            }),
          );
    }),
  );
