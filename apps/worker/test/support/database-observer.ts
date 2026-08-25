/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise, effecttsgo/node-builtin-import -- Vitest global setup owns this Node HTTP boundary. */
/* oxlint-disable osfo/no-runtime-typeof, osfo/no-unknown-parameters, osfo/no-unknown-returns -- This test-only observer decodes raw Node HTTP and database representations at its boundary. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import postgres from "postgres";

export interface DatabaseObserver {
  readonly close: () => Promise<void>;
  readonly origin: string;
}

export interface DatabaseObserverOptions {
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
        .catch((cause: unknown) => respondJson(response, 500, { error: String(cause) }));
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
      join allowance_periods on allowance_periods.user_id = users.id
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
  const body: unknown = JSON.parse(await readTextBody(request));
  if (typeof body === "object" && body !== null && "userId" in body) return String(body.userId);
  throw new Error("Database observation requires a userId");
};

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
