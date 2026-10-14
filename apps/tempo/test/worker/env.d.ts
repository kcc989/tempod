import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_MIGRATIONS?: D1Migration[];
      readonly TEST_LEGACY_DB?: D1Database;
    }
  }
}
