import { Schema } from "effect";
/** AES-256-GCM secret sealing (02, Encryption). WebCrypto only. */

const enc = new TextEncoder();

const dec = new TextDecoder();

const INFO = enc.encode("tempo-secrets-v1");

export const base64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);

  return out;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let s = "";

  for (const b of bytes) s += String.fromCharCode(b);

  return btoa(s);
};

/** Derives the per-user AES key: HKDF-SHA256, salt = user id (or "system"), info = tempo-secrets-v1. */
export const deriveKey = async (masterKeyB64: string, salt: string): Promise<CryptoKey> => {
  const master = base64ToBytes(masterKeyB64);

  if (master.length !== 32) throw new Error("TEMPO_ENCRYPTION_KEY must be 32 bytes, base64");
  const ikm = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(salt), info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

export interface Sealed {
  readonly ciphertext: ArrayBuffer;
  readonly iv: ArrayBuffer;
}

/** The secret's key name is the additional authenticated data, so a ciphertext cannot move keys. */
export const seal = async (key: CryptoKey, name: string, plaintext: string): Promise<Sealed> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(name) },
    key,
    enc.encode(plaintext),
  );

  return { ciphertext, iv: iv.buffer };
};

export const open = async (key: CryptoKey, name: string, sealed: Sealed): Promise<string> => {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(sealed.iv), additionalData: enc.encode(name) },
    key,
    sealed.ciphertext,
  );

  return dec.decode(plain);
};

export const timingSafeEqual = (a: string, b: string): boolean => {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);

  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);

  return diff === 0;
};

export const sha256Hex = async (data: string | Uint8Array<ArrayBuffer>): Promise<string> => {
  const bytes = Schema.is(Schema.String)(data) ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const bytesToBase64Url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export const base64UrlToBytes = (b64url: string): Uint8Array<ArrayBuffer> =>
  base64ToBytes(b64url.replace(/-/g, "+").replace(/_/g, "/"));

/** `n` random bytes from crypto.getRandomValues, base64url without padding. */
export const randomBase64Url = (n: number): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(n)));

export const hmacSha256Base64Url = async (key: Uint8Array<ArrayBuffer>, data: string): Promise<string> => {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data))));
};
