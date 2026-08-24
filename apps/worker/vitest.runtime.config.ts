import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** Focused Worker-runtime tests that need Cloudflare built-ins but no composed application. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-12",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["src/**/*.runtime.test.ts"],
  },
});
