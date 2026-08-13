import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vitest configuration runs at the Node build boundary.
import { readdir } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vitest configuration runs at the Node build boundary.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dbMigrationsPath = fileURLToPath(new URL("./src/db/migrations", import.meta.url));
const migrationDirectories = (await readdir(dbMigrationsPath, { withFileTypes: true })).filter(
  (entry) => entry.isDirectory(),
);
// oxlint-disable-next-line unicorn/no-array-sort -- This fresh local array defines migration order.
migrationDirectories.sort((left, right) => left.name.localeCompare(right.name));
const dbMigrations = (
  await Promise.all(
    migrationDirectories.map((entry) =>
      readD1Migrations(join(dbMigrationsPath, entry.name)).then((migrations) =>
        migrations.map((migration) => ({
          name: `${entry.name}/${migration.name}`,
          queries: migration.queries,
        })),
      ),
    ),
  )
).flat();
/** Local Cloudflare Worker and execution-unit test configuration. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          TEST_DB_MIGRATIONS: dbMigrations,
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
