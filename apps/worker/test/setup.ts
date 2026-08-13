import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, Array.from(env.TEST_DB_MIGRATIONS), "migrations");
