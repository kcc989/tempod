/** Configuration, read only from the environment (README.md lists every variable). */

export const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

export const E2E = {
  /** https://<APP_HOST>, without a trailing slash. */
  url: env("TEMPO_E2E_URL")?.replace(/\/+$/, "") ?? "",
  /** Better Auth session token of the owner, sent as a bearer token. */
  token: env("TEMPO_E2E_TOKEN") ?? "",
  /** A linked test repo. */
  projectId: env("TEMPO_E2E_PROJECT_ID") ?? "",
  /** Playwright storage state of a signed-in owner, for browser UI tests. */
  storageState: env("TEMPO_E2E_STORAGE_STATE"),
  previewDomain: env("TEMPO_E2E_PREVIEW_DOMAIN"),
  /** Keep the workspaces a test creates, for debugging. */
  keep: env("TEMPO_E2E_KEEP") === "1",
};

export const ENABLED = E2E.url !== "";

export const SKIP_REASON =
  "TEMPO_E2E_URL is not set: acceptance tests run only against a deployed test environment (tests/e2e/README.md)";

export const NO_UI_REASON = "TEMPO_E2E_STORAGE_STATE is not set: browser UI tests need a signed-in owner";

/** A variable the current test cannot run without, once TEMPO_E2E_URL is set. */
export const required = (name: string): string => {
  const value = env(name);
  if (value === undefined) throw new Error(`${name} must be set to run this test (tests/e2e/README.md)`);
  return value;
};

export const appHost = (): string => new URL(E2E.url).host;

/** Timing targets from 03 (Timing targets) and 06 (Acceptance tests). */
export const TARGET = {
  firstAgentOutputMs: 120_000,
  wakeFromSnapshotMs: 30_000,
  freshWakeBeforeSetupMs: 90_000,
  prUpdateMs: 60_000,
} as const;
