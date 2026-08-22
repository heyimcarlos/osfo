import { defineConfig } from "vitest/config";

/** Node test configuration for the PostgreSQL database module. */
export default defineConfig({
  test: {
    exclude: ["test/pg-control.test.ts"],
    include: ["test/**/*.test.ts"],
  },
});
