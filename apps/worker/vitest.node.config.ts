import { defineConfig } from "vitest/config";

/** Node-only module tests that exercise SQLite through the Durable SQLite adapter. */
export default defineConfig({
  plugins: [
    {
      name: "raw-agent-migration-sql",
      transform(source, id) {
        if (!id.endsWith(".sql")) return undefined;
        return { code: `export default ${JSON.stringify(source)}`, map: null };
      },
    },
  ],
  test: {
    include: ["src/**/*.node.test.ts", "test/support/**/*.node.test.ts"],
  },
});
