import { defineConfig } from "vitest/config";

/** Fast tests owned by one Worker module and requiring no composed runtime. */
export default defineConfig({
  test: {
    exclude: ["src/**/*.node.test.ts", "src/**/*.runtime.test.ts"],
    include: ["src/**/*.test.ts"],
    // PostgreSQL migration and serialization tests share the host database runtime across files.
    testTimeout: 10_000,
  },
});
