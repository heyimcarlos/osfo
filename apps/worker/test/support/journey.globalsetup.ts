/* oxlint-disable effecttsgo/async-function, effecttsgo/global-random, effecttsgo/node-builtin-import, effecttsgo/process-env -- Vitest global setup owns Node lifecycle and environment access. */
import { randomUUID } from "node:crypto";

import { createTemplateDatabase, dropTestDatabases } from "@osfo/db/testing/postgres";

import { startProviderEmulator, type ProviderEmulator } from "../emulators/provider-emulator";
import { startDatabaseObserver, type DatabaseObserver } from "./database-observer";
import type { JourneyContext } from "./journey-context";

interface GlobalSetupContext {
  readonly provide: (key: "osfoJourney", value: JourneyContext) => void;
}

let context: JourneyContext | undefined;
let databaseObserver: DatabaseObserver | undefined;
let provider: ProviderEmulator | undefined;

export const setup = async ({ provide }: GlobalSetupContext): Promise<void> => {
  const maintenanceUrl = process.env.OSFO_TEST_POSTGRES_URL;
  if (maintenanceUrl === undefined || maintenanceUrl.trim().length === 0) {
    throw new Error("OSFO_TEST_POSTGRES_URL must point to a PostgreSQL maintenance database");
  }

  const runId = randomUUID().replaceAll("-", "");
  const databaseNamePrefix = `osfo_test_${runId}_`;
  const templateName = `${databaseNamePrefix}template`;
  provider = await startProviderEmulator();
  databaseObserver = await startDatabaseObserver({ databaseNamePrefix, maintenanceUrl });
  try {
    await createTemplateDatabase({ maintenanceUrl, templateName });
    context = {
      databaseNamePrefix,
      databaseObserverOrigin: databaseObserver.origin,
      maintenanceUrl,
      providerOrigin: provider.origin,
      templateName,
    };
    provide("osfoJourney", context);
  } catch (cause) {
    await Promise.all([provider.close(), databaseObserver.close()]);
    databaseObserver = undefined;
    provider = undefined;
    throw cause;
  }
};

export const teardown = async (): Promise<void> => {
  const cleanup = context;
  context = undefined;
  try {
    if (cleanup !== undefined) {
      await dropTestDatabases({
        databaseNamePrefix: cleanup.databaseNamePrefix,
        maintenanceUrl: cleanup.maintenanceUrl,
      });
    }
  } finally {
    await Promise.all([provider?.close(), databaseObserver?.close()]);
    databaseObserver = undefined;
    provider = undefined;
  }
};
