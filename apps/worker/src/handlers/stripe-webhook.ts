import { Cause, Effect, Result } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- The web-handler Promise boundary and Effect error tags require these forms. */

import { makeBillingServices } from "../billing-composition";
import * as Db from "../db";
import type { RuntimeConfig } from "../env";

/** Handle the public raw-body Stripe webhook boundary. */
export const layer = (config: RuntimeConfig) => {
  const handler = Effect.gen(function* () {
    const database = yield* Db.database;
    const services = makeBillingServices(database, config);
    return yield* HttpEffect.fromWebHandler(async (request) => {
      const signature = request.headers.get("stripe-signature");
      if (signature === null) return jsonResponse("Invalid Stripe signature", 400);
      const rawBody = await request.text();
      const result = await Effect.runPromiseExit(services.webhooks.handle(rawBody, signature));
      if (result._tag === "Success") return jsonResponse("Webhook received", 200);
      const failure = Cause.findError(result.cause);
      return Result.isSuccess(failure) && failure.success._tag === "InvalidStripeSignature"
        ? jsonResponse("Invalid Stripe signature", 400)
        : jsonResponse("Webhook processing is temporarily unavailable", 503);
    });
  });
  return HttpRouter.add("POST", "/v1/webhooks/stripe", handler);
};

const jsonResponse = (message: string, status: number) =>
  new Response(JSON.stringify({ message }), {
    headers: { "content-type": "application/json" },
    status,
  });
