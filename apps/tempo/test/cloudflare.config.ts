import { bindings, defineConfig, exports } from "cf/config";

// Test config: the deploy shape without containers (Miniflare has no container runtime here).
// The date is the newest the pool's bundled workerd supports; deploys use 2026-10-10.
// The Durable Object bindings are in vitest.worker.config.ts: @cloudflare/vitest-plugin 1.4.2 keeps
// `worker` on a self binding from this file, so workerd looks for a service named tempo-test.
// WORKSPACE is not a binding; tests read it from exports (test/worker/test-env.ts).
export default defineConfig({
  worker: {
    name: "tempo-test",
    entrypoint: "./worker/entry.ts",
    compatibilityDate: "2026-08-22",
    compatibilityFlags: ["nodejs_compat"],
    env: {
      APP_HOST: bindings.text("tempo.test"),
      PREVIEW_DOMAIN: bindings.text("previews.test"),
      TEMPO_OWNER_GITHUB_ID: bindings.text("4242"),
      DB: bindings.d1({ name: "tempo", id: "test" }),
      TEST_LEGACY_DB: bindings.d1({ name: "tempo-legacy", id: "test-legacy" }),
      DATA: bindings.r2({ name: "tempo-data" }),
      LOADER: bindings.workerLoader(),
    },
    exports: {
      WorkspaceDO: exports.durableObject({ storage: "sqlite" }),
      UserHubDO: exports.durableObject({ storage: "sqlite" }),
      CredentialDO: exports.durableObject({ storage: "sqlite" }),
      RepositoryCiDO: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
