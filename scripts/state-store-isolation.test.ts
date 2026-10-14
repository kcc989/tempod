import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../node_modules/alchemy");

const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("pinned Alchemy Tempo isolation", () => {
  it("isolates both Bun and Node paths, including bootstrap, hoist and cold credential refresh", () => {
    expect(JSON.parse(read("package.json")).version).toBe("2.0.0-beta.81");

    for (const [folder, ext] of [
      ["src", "ts"],
      ["lib", "js"],
    ]) {
      const api = read(`${folder}/Cloudflare/StateStore/Api.${ext}`);
      const state = read(`${folder}/Cloudflare/StateStore/State.${ext}`);
      const tokens = read(`${folder}/Cloudflare/StateStore/Token.${ext}`);
      const cache = read(`${folder}/Cloudflare/StateStore/CredentialsFile.${ext}`);
      expect(api).toContain('STATE_STORE_SCRIPT_NAME = "tempo-state-store"');
      expect(tokens).toContain('AuthTokenSecretName = "TempoStateStoreToken"');
      expect(tokens).toContain('EncryptionKeySecretName = "TempoStateStoreEncryptionKey"');
      expect(cache).toContain('CREDENTIALS_FILE = "tempo-state-store-credentials"');
      expect(state).toContain('"TempoStateStore"');
      expect(state).toContain('id: "tempo-cloudflare-http"');
      expect(state).toContain('process.env.TEMPO_STATE_BOOTSTRAP_ALLOWED === "1"');

      for (const source of [api, state, tokens, cache]) {
        expect(source).not.toContain('"alchemy-state-store"');
        expect(source).not.toContain('"CloudflareStateStore"');
        expect(source).not.toContain('"AlchemyStateStoreToken"');
        expect(source).not.toContain('"AlchemyStateStoreEncryptionKey"');
      }
    }
  });
});
