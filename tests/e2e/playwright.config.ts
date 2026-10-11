import { defineConfig, devices } from "@playwright/test";

/**
 * Acceptance tests (06) against a deployed test environment. Every setting comes from the
 * environment; see README.md. Without TEMPO_E2E_URL every test is skipped.
 */
const repeat = Number(process.env["E2E_REPEAT"] ?? "1");
const storageState = process.env["TEMPO_E2E_STORAGE_STATE"]?.trim();

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  retries: 0,
  repeatEach: Number.isInteger(repeat) && repeat > 0 ? repeat : 1,
  reporter: "list",
  // Timing targets (first output, wake) are measured, so tests do not compete for the deployment.
  workers: 1,
  fullyParallel: false,
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env["TEMPO_E2E_URL"]?.trim() || undefined,
    storageState: storageState || undefined,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
});
