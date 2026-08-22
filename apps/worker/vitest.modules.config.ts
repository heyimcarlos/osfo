import { defineConfig } from "vitest/config";

/** Fast tests owned by one Worker module and requiring no composed runtime. */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
