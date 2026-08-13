import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(
  env.DIRECTORY_DB,
  Array.from(env.TEST_DIRECTORY_MIGRATIONS),
  "directory_migrations",
);
await applyD1Migrations(
  env.ERASURE_RECEIPTS_DB,
  Array.from(env.TEST_ERASURE_RECEIPT_MIGRATIONS),
  "erasure_receipt_migrations",
);
