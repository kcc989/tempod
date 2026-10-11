import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { findBinary, run, tail } from "./exec.ts";
import type { Logger } from "./log.ts";

export const CA_ENV_VARS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
] as const;

export const caEnv = (certPath: string): Record<string, string> =>
  Object.fromEntries(CA_ENV_VARS.map((name) => [name, certPath]));

export const waitForFile = async (path: string, timeoutMs: number): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return true;
    if (Date.now() >= end) return false;
    await Bun.sleep(100);
  }
};

/** Startup steps 2 and 3 (01, tempod): wait for the CA, then trust it in Chromium's NSS db. */
export const setupCa = async (config: Config, log: Logger): Promise<Record<string, string>> => {
  const found = await waitForFile(config.caCert, config.caWaitMs);
  if (!found) {
    log.warn("CA certificate not found; continuing without it", { path: config.caCert });
    return {};
  }
  const certutil = findBinary("certutil");
  if (certutil) {
    try {
      const db = `sql:${config.nssDb}`;
      if (!existsSync(join(config.nssDb, "cert9.db"))) {
        mkdirSync(config.nssDb, { recursive: true });
        const r = await run([certutil, "-d", db, "-N", "--empty-password"], { timeoutMs: 30_000 });
        if (r.code !== 0) log.warn("certutil -N failed", { stderr: tail(r.stderr, 500) });
      }
      const r = await run([certutil, "-d", db, "-A", "-t", "C,,", "-n", "cloudflare-containers", "-i", config.caCert], {
        timeoutMs: 30_000,
      });
      if (r.code !== 0) log.warn("certutil -A failed", { stderr: tail(r.stderr, 500) });
    } catch (e) {
      log.warn("certutil failed", { error: String(e) });
    }
  }
  return caEnv(config.caCert);
};
