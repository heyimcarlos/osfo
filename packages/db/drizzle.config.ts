import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";
import { Config, Effect } from "effect";

dotenv.config({ path: "../../apps/worker/.env" });
const databaseUrl = Effect.runSync(Config.string("DATABASE_URL"));

export default defineConfig({
  dbCredentials: {
    url: databaseUrl,
  },
  dialect: "postgresql",
  out: "./src/migrations",
  schema: "./src/schema",
});
