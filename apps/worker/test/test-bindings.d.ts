import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_DB_MIGRATIONS: Array<D1Migration>;
    }
  }
}
