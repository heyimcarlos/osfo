import { BrowserCrypto } from "@effect/platform-browser";
import { agents } from "@osfo/db/schema/agents";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";

import { Db } from "../src/db";
import { AgentId } from "../src/domain";
import { AuthSessionId } from "../src/domain/auth-session";
import { inspect } from "../src/integrations/postgres/session-recall-authorization";
import { userId, withAccountAuthorityFixture } from "./account-authority-fixture";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide -- This integration fixture owns its PGlite and Layer entry points. */

describe("PostgreSQL Session Recall authorization", () => {
  it.effect("joins the current authority, ownership, and subscription facts", () =>
    withAccountAuthorityFixture(({ database }) =>
      Effect.gen(function* () {
        const agentId = AgentId.make("agent-recall-authorization");
        yield* Effect.promise(() =>
          database.database.transaction(async (transaction) => {
            await transaction.insert(agents).values({
              agent_id: agentId,
              created_at: "2026-08-17T00:00:00.000Z",
              user_id: userId,
            });
            await transaction.insert(billingSubscriptions).values({
              billing_subscription_id: "billing-recall-authorization",
              plan: "adventurer",
              plan_policy_version: "launch-v1",
              stripe_current_period_end: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-09-17T00:00:00.000Z"),
              ),
              stripe_current_period_start: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-08-17T00:00:00.000Z"),
              ),
              stripe_latest_invoice_id: "in_recall_authorization",
              stripe_price_id: "price_adventurer",
              stripe_product_id: "prod_adventurer",
              stripe_status: "active",
              stripe_subscription_id: "sub_recall_authorization",
              user_id: userId,
            });
          }),
        );
        const facts = yield* Effect.scoped(
          inspect(agentId, {
            _tag: "AuthSession",
            authSessionId: AuthSessionId.make("auth-session-1"),
            userId,
          }).pipe(
            Effect.provide(
              Layer.mergeAll(BrowserCrypto.layer, Db.layerFromDatabase(database.database)),
            ),
          ),
        );

        expect(facts).toMatchObject({
          authority: { _tag: "AuthSession", authSessionId: "auth-session-1", userId },
          deletionAccess: { _tag: "DeletionAccessAvailable" },
          resourceOwnerUserId: userId,
          subscription: { plan: "adventurer", planPolicyVersion: "launch-v1" },
          user: { _tag: "ActiveUser", userId },
        });
      }),
    ),
  );
});
