import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./web",
  outputDir: "./web-test-results",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4179", trace: "retain-on-failure" },
  projects: [
    {
      name: "desktop-chromium",
      grepInvert: /phone navigation/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "desktop-dark",
      grep: /theme follows the selected appearance/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
    },
    {
      name: "phone-chromium",
      grep: /@mobile/,
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command:
      "bun run --cwd ../.. turbo run build:web-fixture --filter=@tempo/app && bun run --cwd ../../apps/tempo vite preview --config vite.web-test.config.ts --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
});
