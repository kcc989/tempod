import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./web",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4179", trace: "retain-on-failure" },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "desktop-firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1440, height: 900 },
        launchOptions:
          process.env["TEMPO_WEB_NO_SANDBOX"] === "1"
            ? {
                firefoxUserPrefs: {
                  "security.sandbox.content.level": 0,
                  "security.sandbox.socket.process.level": 0,
                  "media.cubeb.sandbox": false,
                },
              }
            : {},
      },
    },
    { name: "desktop-webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } } },
    {
      name: "desktop-dark",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
    },
    { name: "phone-chromium", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command: "bun run --cwd ../../apps/tempo dev:web-test",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
});
