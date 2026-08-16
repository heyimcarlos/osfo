import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./src/agents/osfo/db/migrations",
  schema: "./src/agents/osfo/db/schema.ts",
});
