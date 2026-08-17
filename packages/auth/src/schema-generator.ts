import { schema as databaseSchema, type Database } from "@osfo/db";
import { drizzle } from "drizzle-orm/postgres-js";

import { createAuth, type Auth } from "./index";

const database: Database = drizzle.mock({ schema: databaseSchema });

/** Build-only Better Auth instance loaded by the schema generator. */
export const auth: Auth = createAuth({
  baseURL: "https://schema.invalid",
  canCreateSession: () => Promise.resolve(true),
  credentialAuthentication: "disabled",
  database,
  dashboard: { apiKey: "schema-generation-only-api-key", kind: "enabled" },
  secret: "schema-generation-only-secret-value",
  sendOTP: () => Promise.resolve(),
  trustedOrigins: ["https://schema.invalid"],
  verifyOTP: () => Promise.resolve(false),
});
