import { defineConfig } from "drizzle-kit";

const defaultLocalDatabaseUrl = "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle";

export default defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema.ts",
  dbCredentials: {
    url: process.env.OSFO_DATABASE_URL ?? defaultLocalDatabaseUrl,
  },
});
