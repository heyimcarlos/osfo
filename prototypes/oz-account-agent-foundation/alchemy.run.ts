import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AccountAgent } from "./src/account-agent.ts";

export default Alchemy.Stack(
  "OzAccountAgentFoundationPrototype",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers()),
    state: process.env.ALCHEMY_STAGE === "live" ? Cloudflare.state() : Alchemy.localState(),
  },
  Effect.gen(function* () {
    const directorySchema = yield* Drizzle.Schema("DirectorySchema", {
      dialect: "sqlite",
      out: "./migrations/d1",
      schema: "./src/directory-schema.ts",
    });
    const directory = yield* Cloudflare.D1.Database("Directory", {
      migrationsDir: directorySchema.out,
      migrationsTable: "drizzle_migrations",
    });
    const accountAgent = Cloudflare.DurableObject<AccountAgent>("AccountAgent");
    const api = yield* Cloudflare.Worker("Api", {
      compatibility: { date: "2026-06-11", flags: ["nodejs_compat"] },
      dev: { mode: "worker", port: 1337, strictPort: true },
      env: {
        ACCOUNT_AGENT: accountAgent,
        DIRECTORY: directory,
        MODEL_PROVIDER: process.env.ALCHEMY_STAGE === "live" ? "openrouter" : "prototype",
        OPENROUTER_API_KEY: Config.redacted("OPENROUTER_API_KEY"),
        OPENROUTER_MODEL: "openai/gpt-5-nano",
        PROTOTYPE_TOKEN: Config.redacted("OZ_PROTOTYPE_TOKEN"),
      },
      main: "./src/worker.ts",
    });

    return { url: api.url.as<string>() };
  }),
);
