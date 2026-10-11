import { TempoError } from "@tempo/protocol";
import { SYSTEM_CREDENTIALS, type GithubAppConfig } from "../do/credential.ts";
import type { Env } from "../env.ts";
import { base64ToBytes, bytesToBase64 } from "../lib/crypto.ts";

const CACHE_MS = 5 * 60_000;
let cached: { config: GithubAppConfig | null; at: number } | null = null;

/** GitHub App config from the `system` CredentialDO, cached in isolate memory for 5 minutes (05). */
export const getGithubAppConfig = async (env: Env, { fresh = false } = {}): Promise<GithubAppConfig | null> => {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.config;
  const config = await env.CREDENTIALS.getByName(SYSTEM_CREDENTIALS).getGithubAppConfig();
  cached = { config, at: Date.now() };
  return config;
};

export const clearGithubAppConfigCache = () => {
  cached = null;
};

export const requireGithubAppConfig = async (env: Env): Promise<GithubAppConfig> => {
  const config = await getGithubAppConfig(env);
  if (!config) throw new TempoError("GITHUB_API_ERROR", "The GitHub App is not set up yet.");
  return config;
};

const b64url = (bytes: Uint8Array | string): string =>
  (typeof bytes === "string" ? btoa(bytes) : bytesToBase64(bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const derLength = (n: number): number[] => {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
};

/** GitHub issues PKCS#1 keys; WebCrypto wants PKCS#8. Wrap the RSAPrivateKey in a PrivateKeyInfo. */
export const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array<ArrayBuffer> => {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const bodyLen = version.length + algorithm.length + octet.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(bodyLen), ...version, ...algorithm, ...octet, ...pkcs1]);
  return out;
};

const importPrivateKey = async (pem: string): Promise<CryptoKey> => {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  const der = base64ToBytes(body);
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
};

let keyCache: { pem: string; key: Promise<CryptoKey> } | null = null;

/** App JWT (RS256), valid 9 minutes, backdated 60 s for clock drift. */
export const appJwt = async (config: GithubAppConfig, now = Date.now()): Promise<string> => {
  if (!keyCache || keyCache.pem !== config.privateKey) {
    keyCache = { pem: config.privateKey, key: importPrivateKey(config.privateKey) };
  }
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: config.appId }));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await keyCache.key, data);
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
};
