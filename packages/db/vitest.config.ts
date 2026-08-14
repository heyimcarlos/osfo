import { defineConfig } from "vitest/config";

/** Node test configuration for the PostgreSQL database module. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
