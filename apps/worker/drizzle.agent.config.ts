import { defineConfig } from "drizzle-kit";

/** Drizzle Kit configuration for generated Osfo Agent SQLite migrations. */
export default defineConfig({
  dialect: "sqlite",
  out: "./src/agents/osfo/db/migrations",
  schema: "./src/agents/osfo/db/schema.ts",
});
