import type { Database } from "../index";
import { Effect } from "effect";

import type { Persistence } from "../../services/stripe-webhooks";
import { fail, markProcessed } from "./fail";
import { receive } from "./receive";
import { replay } from "./replay";

/** Concrete dependencies for provider-neutral webhook persistence. */
export interface MakeOptions {
  readonly database: Pick<Database, "transaction" | "update">;
  readonly webhookEventId: Effect.Effect<string>;
}

/** Small durable webhook interface, including explicit operator replay. */
export interface Interface extends Persistence {
  readonly replay: (webhookEventId: string) => ReturnType<typeof replay>;
}

/** Construct provider-neutral webhook persistence. */
export const make = (options: MakeOptions): Interface => ({
  fail: (webhookEventId, errorCode, checkoutEvidence) =>
    fail(options.database, webhookEventId, errorCode, checkoutEvidence),
  markProcessed: (webhookEventId, checkoutEvidence) =>
    markProcessed(options.database, webhookEventId, checkoutEvidence),
  receive: (event) =>
    options.webhookEventId.pipe(
      Effect.flatMap((webhookEventId) => receive(options.database, webhookEventId, event)),
    ),
  replay: (webhookEventId) => replay(options.database, webhookEventId),
});
