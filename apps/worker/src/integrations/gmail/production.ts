import { createAuth } from "@osfo/auth";
import type { Database } from "@osfo/db";
import { Effect, Redacted } from "effect";

import type { AuthRouteConfig } from "../../auth";
import { GmailProviderUnavailable } from "../../domain/gmail";
import * as GmailDb from "../../db/gmail";
import * as GmailApi from "./api";

/** Construct the production Gmail provider and its Better Auth owned credential adapter. */
export const make = (database: Database, config: AuthRouteConfig) => {
  const auth = createAuth({
    baseURL: config.baseURL,
    database,
    dashboard: { kind: "disabled" },
    google: {
      clientId: config.google.clientId,
      clientSecret: Redacted.value(config.google.clientSecret),
      kind: "disabled",
    },
    secret: Redacted.value(config.secret),
    sendOTP: () => Promise.resolve(),
    trustedOrigins: [...config.trustedOrigins],
    verifyOTP: () => Promise.resolve(false),
  });
  const gmailDatabase = GmailDb.make(database, (connection, operation) =>
    Effect.tryPromise({
      try: () =>
        auth.api.getAccessToken({
          body: {
            accountId: connection.providerAccountId,
            providerId: "google",
            userId: connection.userId,
          },
        }),
      catch: (cause) =>
        new GmailProviderUnavailable({
          cause,
          message: "The owned Gmail OAuth access token could not be refreshed",
          operation,
        }),
    }).pipe(Effect.map(({ accessToken }) => Redacted.make(accessToken))),
  );
  return GmailApi.make({ credentials: gmailDatabase.credentials }).pipe(
    Effect.map((provider) => ({ database: gmailDatabase, provider })),
  );
};
