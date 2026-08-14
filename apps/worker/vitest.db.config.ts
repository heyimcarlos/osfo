import { defineConfig } from "vitest/config";

/** Node test configuration for Worker services backed by embedded PostgreSQL. */
export default defineConfig({
  test: {
    include: ["test/db.test.ts"],
  },
});
