/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env, effecttsgo/global-date -- throwaway S0 spike harness code, plain Node is intentional */
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(() => ({
      wrangler: { configPath: "./test/s0/wrangler.spike.jsonc" },
      miniflare: {
        bindings: {
          SPIKE_MARKER: `boot-${Date.now()}`,
          DB: { connectionString: "postgres://osfo:osfo@127.0.0.1:5432/osfo_s0_auth" },
        },
      },
    })),
  ],
  test: {
    include: ["test/s0/**/*.db-identity.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
