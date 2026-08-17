import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { agents } from "@osfo/db/schema/agents";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";

import * as Db from "../src/db";
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
              agentId,
              createdAt: "2026-08-17T00:00:00.000Z",
              userId,
            });
            await transaction.insert(billingSubscriptions).values({
              billingSubscriptionId: "billing-recall-authorization",
              plan: "adventurer",
              planPolicyVersion: "launch-v1",
              stripeCurrentPeriodEnd: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-09-17T00:00:00.000Z"),
              ),
              stripeCurrentPeriodStart: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-08-17T00:00:00.000Z"),
              ),
              stripeLatestInvoiceId: "in_recall_authorization",
              stripePriceId: "price_adventurer",
              stripeProductId: "prod_adventurer",
              stripeStatus: "active",
              stripeSubscriptionId: "sub_recall_authorization",
              userId,
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
