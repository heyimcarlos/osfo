/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise, effecttsgo/node-builtin-import -- Vitest global setup owns this Node HTTP boundary. */
/* oxlint-disable osfo/no-runtime-typeof, osfo/no-unknown-parameters, osfo/no-unknown-returns -- This test-only observer adapts raw Node HTTP and database representations at its boundary. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Data, Schema } from "effect";
import postgres from "postgres";

const NonEmptyText = Schema.String.check(Schema.isMinLength(1));
const UserRequestFromJson = Schema.fromJsonString(Schema.Struct({ userId: NonEmptyText }));
const AccountDeletionActionRequestFromJson = Schema.fromJsonString(
  Schema.Struct({ actionId: NonEmptyText, userId: NonEmptyText }),
);
const VersionedAccountDeletionActionRequestFromJson = Schema.fromJsonString(
  Schema.Struct({
    actionId: NonEmptyText,
    presentationVersion: NonEmptyText,
    userId: NonEmptyText,
  }),
);
const decodeUserRequest = Schema.decodeUnknownPromise(UserRequestFromJson);
const decodeAccountDeletionActionRequest = Schema.decodeUnknownPromise(
  AccountDeletionActionRequestFromJson,
);
const decodeVersionedAccountDeletionActionRequest = Schema.decodeUnknownPromise(
  VersionedAccountDeletionActionRequestFromJson,
);

type AccountDeletionActionRequest = typeof AccountDeletionActionRequestFromJson.Type;
type VersionedAccountDeletionActionRequest =
  typeof VersionedAccountDeletionActionRequestFromJson.Type;

export interface DatabaseObserverAccountDeletionMutations {
  readonly expire: (input: AccountDeletionActionRequest) => Promise<void>;
  readonly version: (input: VersionedAccountDeletionActionRequest) => Promise<void>;
}

export interface DatabaseObserver {
  readonly close: () => Promise<void>;
  readonly origin: string;
}

export interface DatabaseObserverOptions {
  readonly accountDeletionMutations?: DatabaseObserverAccountDeletionMutations;
  readonly databaseNamePrefix: string;
  readonly maintenanceUrl: string;
}

/** Observe committed journey state from Node, outside workerd's PostgreSQL pool. */
export const startDatabaseObserver = (
  options: DatabaseObserverOptions,
): Promise<DatabaseObserver> =>
  new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "POST" && path === "/expire-account-deletion-action") {
        readAccountDeletionAction(request)
          .then((input) =>
            options.accountDeletionMutations === undefined
              ? expireAccountDeletionAction(options, input.userId, input.actionId)
              : options.accountDeletionMutations.expire(input),
          )
          .then(() => respondJson(response, 200, { status: "expired" }))
          .catch((cause: unknown) => respondObserverFailure(response, cause));
        return;
      }
      if (request.method === "POST" && path === "/version-account-deletion-action") {
        readVersionedAccountDeletionAction(request)
          .then((input) =>
            options.accountDeletionMutations === undefined
              ? versionAccountDeletionAction(
                  options,
                  input.userId,
                  input.actionId,
                  input.presentationVersion,
                )
              : options.accountDeletionMutations.version(input),
          )
          .then(() => respondJson(response, 200, { status: "versioned" }))
          .catch((cause: unknown) => respondObserverFailure(response, cause));
        return;
      }
      const query =
        path === "/registration"
          ? findRegistration
          : path === "/billing-checkout"
            ? findBillingCheckout
            : path === "/account-deletion"
              ? findAccountDeletion
              : null;
      if (request.method !== "POST" || query === null) {
        respondJson(response, 404, { error: "Not found" });
        return;
      }
      readUserId(request)
        .then((userId) => query(options, userId))
        .then((row) => respondJson(response, 200, row))
        .catch((cause: unknown) => respondObserverFailure(response, cause));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Database observer did not acquire a TCP port"));
        return;
      }
      resolve({
        close: () => closeServer(server),
        origin: `http://127.0.0.1:${address.port}`,
      });
    });
  });

const expireAccountDeletionAction = async (
  options: DatabaseObserverOptions,
  userId: string,
  actionId: string,
) => {
  const expired = await findJourneyRow(options, async (client) => {
    const [row] = await client`
      update account_deletion_actions
      set created_at = consumed_at - interval '2 seconds',
          expires_at = consumed_at - interval '1 second'
      where user_id = ${userId}
        and action_id = ${actionId}
        and consumed_at is not null
      returning action_id
    `;
    return row;
  });
  if (expired === null) throw new Error("Consumed account deletion Action was not found");
};

const versionAccountDeletionAction = async (
  options: DatabaseObserverOptions,
  userId: string,
  actionId: string,
  presentationVersion: string,
) => {
  const versioned = await findJourneyRow(options, async (client) => {
    const [row] = await client`
      update account_deletion_actions
      set presentation_version = ${presentationVersion}
      where user_id = ${userId}
        and action_id = ${actionId}
        and consumed_at is null
      returning action_id
    `;
    return row;
  });
  if (versioned === null) throw new Error("Unconsumed account deletion Action was not found");
};

const findBillingCheckout = async (options: DatabaseObserverOptions, userId: string) =>
  findJourneyRow(options, async (client) => {
    const [row] = await client`
      select
        billing_checkout_sessions.billing_checkout_session_id,
        billing_checkout_sessions.state,
        billing_checkout_sessions.stripe_checkout_session_id,
        billing_checkout_sessions.stripe_price_id,
        billing_checkout_sessions.stripe_product_id,
        billing_checkout_sessions.target_plan,
        billing_customers.billing_customer_id,
        billing_customers.stripe_customer_id
      from billing_checkout_sessions
      join billing_customers
        on billing_customers.billing_customer_id = billing_checkout_sessions.billing_customer_id
      where billing_checkout_sessions.user_id = ${userId}
    `;
    return row;
  });

const findRegistration = async (options: DatabaseObserverOptions, userId: string) =>
  findJourneyRow(options, async (client) => {
    const [row] = await client`
      select
        agents.agent_id,
        allowance_periods.plan as allowance_plan,
        billing_subscriptions.plan as billing_plan,
        users.help_areas,
        users.locale,
        users.phone_number_verified,
        users.preferred_name,
        users.registration_completed_at
      from users
      join agents on agents.user_id = users.id
      join billing_subscriptions on billing_subscriptions.user_id = users.id
      join lateral (
        select allowance_periods.plan
        from allowance_periods
        where allowance_periods.user_id = users.id
        order by allowance_periods.starts_at desc
        limit 1
      ) allowance_periods on true
      where users.id = ${userId}
    `;
    return row;
  });

const findAccountDeletion = async (options: DatabaseObserverOptions, userId: string) =>
  findJourneyRow(options, async (client) => {
    const [row] = await client`
      select
        exists(select 1 from users where id = ${userId}) as user_exists,
        exists(select 1 from agents where user_id = ${userId}) as agent_exists,
        exists(select 1 from sessions where user_id = ${userId}) as auth_session_exists,
        exists(select 1 from deletion_cases where user_id = ${userId}) as deletion_case_exists
      where exists(select 1 from users where id = ${userId})
        or exists(select 1 from agents where user_id = ${userId})
        or exists(select 1 from sessions where user_id = ${userId})
        or exists(select 1 from deletion_cases where user_id = ${userId})
    `;
    return row;
  });

const findJourneyRow = async (
  options: DatabaseObserverOptions,
  query: (client: ReturnType<typeof postgres>) => Promise<unknown>,
) => {
  const databaseNames = await withClient(options.maintenanceUrl, async (client) => {
    const rows = await client<Array<{ readonly datname: string }>>`
      select datname from pg_database where datname like ${`${options.databaseNamePrefix}%`}
    `;
    return rows
      .map((row) => row.datname)
      .filter((name) => name.startsWith(`${options.databaseNamePrefix}journey_`));
  });
  for (const databaseName of databaseNames) {
    const connectionUrl = new URL(options.maintenanceUrl);
    connectionUrl.pathname = `/${databaseName}`;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each isolated journey database is inspected in deterministic order.
    const row = await withClient(connectionUrl.href, query);
    if (row !== undefined) return row;
  }
  return null;
};

const withClient = async <A>(
  connectionString: string,
  use: (client: ReturnType<typeof postgres>) => Promise<A>,
): Promise<A> => {
  const client = postgres(connectionString, { max: 1, prepare: false });
  try {
    return await use(client);
  } finally {
    await client.end({ timeout: 0 });
  }
};

const readUserId = async (request: IncomingMessage): Promise<string> => {
  const body = await readTextBody(request);
  return decodeUserRequest(body)
    .then(({ userId }) => userId)
    .catch((cause: unknown) => {
      throw new DatabaseObserverRequestInvalid({ cause });
    });
};

const readAccountDeletionAction = async (
  request: IncomingMessage,
): Promise<AccountDeletionActionRequest> =>
  decodeAccountDeletionActionRequest(await readTextBody(request)).catch((cause: unknown) => {
    throw new DatabaseObserverRequestInvalid({ cause });
  });

const readVersionedAccountDeletionAction = async (
  request: IncomingMessage,
): Promise<VersionedAccountDeletionActionRequest> =>
  decodeVersionedAccountDeletionActionRequest(await readTextBody(request)).catch(
    (cause: unknown) => {
      throw new DatabaseObserverRequestInvalid({ cause });
    },
  );

const readTextBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const respondJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};

const respondObserverFailure = (response: ServerResponse, cause: unknown): void => {
  if (cause instanceof DatabaseObserverRequestInvalid) {
    respondJson(response, 400, { error: "Invalid request body" });
    return;
  }
  respondJson(response, 500, { error: String(cause) });
};

class DatabaseObserverRequestInvalid extends Data.TaggedError("DatabaseObserverRequestInvalid")<{
  readonly cause: unknown;
}> {}
