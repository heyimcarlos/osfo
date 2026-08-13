import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_DIRECTORY_MIGRATIONS: Array<D1Migration>;
      readonly TEST_DIRECTORY_MIGRATION_DIGESTS: Array<{
        readonly digest: string;
        readonly name: string;
      }>;
      readonly TEST_ERASURE_RECEIPT_MIGRATIONS: Array<D1Migration>;
    }
  }
}
