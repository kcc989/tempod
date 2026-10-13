import { defineConfig, devices } from "@playwright/test";

/** Local UI regressions with protocol fixtures; these do not satisfy hosted acceptance gates. */
export default defineConfig({
  testDir: "./browser-tests",
  retries: 0,
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      grepInvert: /phone layout/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "phone-chromium",
      grep: /phone layout/,
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command:
      "bun run --cwd ../.. turbo run build:browser-fixture --filter=@tempo/app && bun run --cwd ../../apps/tempo vite preview --config test/browser/vite.config.ts --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
