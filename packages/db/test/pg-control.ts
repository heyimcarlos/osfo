/* oxlint-disable effecttsgo/async-function -- Vitest global setup owns Promise lifecycle boundaries. */
import { Effect } from "effect";
import postgres from "postgres";

import { readMigrations } from "@osfo/db/testing/migrations";

const testDatabasePrefix = "osfo_test_";
const testDatabaseName = /^osfo_test_[a-z0-9_]+$/;
/** One native PostgreSQL database created for a test run. */
export interface PostgresTestDatabase {
  readonly connectionString: string;
  readonly name: string;
}

export interface CreateTemplateDatabaseOptions {
  readonly maintenanceUrl: string;
  readonly templateName: string;
}

export interface CloneTestDatabaseOptions {
  readonly databaseName: string;
  readonly maintenanceUrl: string;
  readonly templateName: string;
}

export interface DropTestDatabaseOptions {
  readonly databaseName: string;
  readonly maintenanceUrl: string;
}

export interface DropTestDatabasesOptions {
  readonly databaseNamePrefix: string;
  readonly maintenanceUrl: string;
}

/** Create one migrated PostgreSQL template, replacing a stale template with the same name. */
export const createTemplateDatabase = async ({
  maintenanceUrl,
  templateName,
}: CreateTemplateDatabaseOptions): Promise<PostgresTestDatabase> => {
  assertMaintenanceUrl(maintenanceUrl);
  assertTestDatabaseName(templateName);
  await dropTestDatabase({ databaseName: templateName, maintenanceUrl });

  try {
    await withClient(maintenanceUrl, (client) =>
      client`create database ${client(templateName)}`.execute(),
    );
    const connectionString = databaseConnectionString(maintenanceUrl, templateName);
    const migrations = await Effect.runPromise(readMigrations);
    await withClient(connectionString, async (client) => {
      for (const migration of migrations) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Migrations must commit in deployment order.
        await client.begin(async (transaction) => {
          for (const statement of migration.statements) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Statements must run in committed migration order.
            await transaction.unsafe(statement);
          }
        });
      }
    });
    await withClient(maintenanceUrl, (client) =>
      client`alter database ${client(templateName)} with is_template true allow_connections false`.execute(),
    );
    return { connectionString, name: templateName };
  } catch (cause) {
    await dropTestDatabase({ databaseName: templateName, maintenanceUrl });
    throw new Error(`Could not create migrated PostgreSQL template ${templateName}`, { cause });
  }
};

/** Clone one isolated PostgreSQL database from a migrated test template. */
export const cloneTestDatabase = async ({
  databaseName,
  maintenanceUrl,
  templateName,
}: CloneTestDatabaseOptions): Promise<PostgresTestDatabase> => {
  assertMaintenanceUrl(maintenanceUrl);
  assertTestDatabaseName(databaseName);
  assertTestDatabaseName(templateName);

  try {
    await withClient(maintenanceUrl, (client) =>
      client`create database ${client(databaseName)} template ${client(templateName)}`.execute(),
    );
    return {
      connectionString: databaseConnectionString(maintenanceUrl, databaseName),
      name: databaseName,
    };
  } catch (cause) {
    throw new Error(`Could not clone PostgreSQL test database ${databaseName}`, { cause });
  }
};

/** Force-drop one database whose name is confined to the Osfo test prefix. */
export const dropTestDatabase = async ({
  databaseName,
  maintenanceUrl,
}: DropTestDatabaseOptions): Promise<void> => {
  assertMaintenanceUrl(maintenanceUrl);
  assertTestDatabaseName(databaseName);

  try {
    await withClient(maintenanceUrl, async (client) => {
      const [existing] = await client`select 1 from pg_database where datname = ${databaseName}`;
      if (existing === undefined) return;
      await client`alter database ${client(databaseName)} with is_template false allow_connections false`;
      await client`drop database ${client(databaseName)} with (force)`;
    });
  } catch (cause) {
    throw new Error(`Could not drop PostgreSQL test database ${databaseName}`, { cause });
  }
};

/** Force-drop every Osfo test database whose name begins with one run-owned prefix. */
export const dropTestDatabases = async ({
  databaseNamePrefix,
  maintenanceUrl,
}: DropTestDatabasesOptions): Promise<void> => {
  assertMaintenanceUrl(maintenanceUrl);
  assertTestDatabaseName(databaseNamePrefix);

  try {
    const databaseNames = await withClient(maintenanceUrl, async (client) => {
      const rows = await client<Array<{ readonly datname: string }>>`
        select datname
        from pg_database
        where datname like ${`${escapeLike(databaseNamePrefix)}%`} escape '\\'
      `;
      return rows.map((row) => row.datname);
    });
    for (const databaseName of databaseNames) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- PostgreSQL database drops are deliberately serialized.
      await dropTestDatabase({ databaseName, maintenanceUrl });
    }
  } catch (cause) {
    throw new Error(
      `Could not drop PostgreSQL test databases beginning with ${databaseNamePrefix}`,
      { cause },
    );
  }
};

const withClient = async <A>(
  connectionString: string,
  use: (client: ReturnType<typeof postgres>) => Promise<A>,
): Promise<A> => {
  const client = postgres(connectionString, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  try {
    return await use(client);
  } finally {
    await client.end({ timeout: 0 });
  }
};

const databaseConnectionString = (maintenanceUrl: string, databaseName: string): string => {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${databaseName}`;
  return url.href;
};

const assertMaintenanceUrl = (maintenanceUrl: string): void => {
  let url: URL;
  try {
    url = new URL(maintenanceUrl);
  } catch (cause) {
    throw new Error("OSFO_TEST_POSTGRES_URL must be a PostgreSQL URL", { cause });
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("OSFO_TEST_POSTGRES_URL must use the postgres protocol");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (databaseName.length === 0 || databaseName.startsWith(testDatabasePrefix)) {
    throw new Error("OSFO_TEST_POSTGRES_URL must target a maintenance database");
  }
};

const assertTestDatabaseName = (databaseName: string): void => {
  if (!testDatabaseName.test(databaseName) || databaseName.length > 63) {
    throw new Error(`Refusing to manage non-test PostgreSQL database ${databaseName}`);
  }
};

const escapeLike = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("_", "\\_").replaceAll("%", "\\%");
