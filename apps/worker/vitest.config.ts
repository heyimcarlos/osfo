import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const directoryMigrationMetadata = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("./drizzle/directory", import.meta.url)),
});
const directoryMigrations = directoryMigrationMetadata.map((migration) => ({
  name: migration.name,
  queries: migration.sql,
}));
const directoryMigrationDigests = directoryMigrationMetadata.map((migration) => ({
  digest: migration.hash,
  name: migration.name,
}));
const erasureReceiptMigrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("./drizzle/erasure-receipts", import.meta.url)),
}).map((migration) => ({ name: migration.name, queries: migration.sql }));

/** Local Cloudflare Worker and execution-unit test configuration. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          TEST_DIRECTORY_MIGRATIONS: directoryMigrations,
          TEST_DIRECTORY_MIGRATION_DIGESTS: directoryMigrationDigests,
          TEST_ERASURE_RECEIPT_MIGRATIONS: erasureReceiptMigrations,
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
