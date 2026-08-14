import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const workerBindings = {
  BETTER_AUTH_API_KEY: "test-only-better-auth-dashboard-api-key",
  BETTER_AUTH_BASE_URL: "https://osfo.test",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters",
  BETTER_AUTH_TRUSTED_ORIGINS: '["https://osfo.test"]',
  TWILIO_ACCOUNT_SID: "AC11111111111111111111111111111111",
  TWILIO_AUTH_TOKEN: "test-only-twilio-token",
  TWILIO_VERIFY_SERVICE_SID: "VA22222222222222222222222222222222",
};

/** Local Cloudflare Worker and execution-unit test configuration. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: { bindings: workerBindings },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: { include: ["test/worker.test.ts"], testTimeout: 15_000 },
});
