import { defineConfig } from "vitest/config";

/** Node-only module tests that exercise SQLite through the Durable SQLite adapter. */
export default defineConfig({
  test: {
    include: ["src/**/*.node.test.ts"],
  },
});
