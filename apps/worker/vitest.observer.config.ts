import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** Focused runtime coverage for the local read-only verification Worker. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-12",
        compatibilityFlags: ["nodejs_compat"],
      },
      wrangler: { configPath: "./test/wrangler.observer.jsonc" },
    }),
  ],
  test: { include: ["test/observer/**/*.test.ts"] },
});
