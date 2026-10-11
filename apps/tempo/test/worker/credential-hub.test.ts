import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { newId, type WorkspaceSummary } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import type { CredentialDO, SecretStatus } from "../../src/do/credential.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { seedCredentials, seedProject, seedWorkspace, waitFor, type Seeded } from "./fakes.ts";

// ---------- helpers ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

interface RawSecret {
  key: string;
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
  version: number;
  meta_json: string;
  updated_at: number;
}

const credsFor = (name: string) => env.CREDENTIALS.getByName(name);

const rawSecret = async (
  stub: DurableObjectStub<CredentialDO>,
  key: string,
): Promise<RawSecret | undefined> =>
  runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => {
    const rows = state.storage.sql.exec("SELECT * FROM secrets WHERE key = ?", key).toArray();
    return rows[0] as unknown as RawSecret | undefined;
  });

const writeRawSecret = async (stub: DurableObjectStub<CredentialDO>, row: RawSecret): Promise<void> =>
  runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO secrets (key, ciphertext, iv, version, meta_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      row.key,
      row.ciphertext,
      row.iv,
      row.version,
      row.meta_json,
      row.updated_at,
    );
  });

const leaseRows = async (stub: DurableObjectStub<CredentialDO>): Promise<string[]> =>
  runInDurableObject(stub, (_i: unknown, state: DurableObjectState) =>
    state.storage.sql
      .exec("SELECT workspace_id FROM codex_leases ORDER BY workspace_id")
      .toArray()
      .map((r) => String(r.workspace_id)),
  );

/** An independent implementation of 02 "Encryption": HKDF-SHA256, salt = instance name, info = tempo-secrets-v1. */
const specKey = async (salt: string): Promise<CryptoKey> => {
  const bin = atob(env.TEMPO_ENCRYPTION_KEY);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(salt), info: enc.encode("tempo-secrets-v1") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const specOpen = async (salt: string, aad: string, row: RawSecret): Promise<string> =>
  dec.decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(row.iv), additionalData: enc.encode(aad) },
      await specKey(salt),
      row.ciphertext,
    ),
  );

const codexAuth = (lastRefreshIso: string, access = `at-${newId()}`) =>
  JSON.stringify({
    tokens: { access_token: access, refresh_token: `rt-${newId()}` },
    last_refresh: lastRefreshIso,
  });

const summary = (over: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id: newId(),
  projectId: newId(),
  slug: "paris",
  title: "paris",
  branch: "tempo/paris",
  baseBranch: "main",
  state: "ready",
  attention: "none",
  defaultAgent: "claude",
  prNumber: null,
  prState: null,
  checksState: null,
  pinned: false,
  lastActivityAt: 1_000,
  createdAt: 1_000,
  archivedAt: null,
  rev: 1,
  ...over,
});

interface HubSocket {
  readonly ws: WebSocket;
  readonly messages: any[];
  readonly status: number;
  close(): void;
}

const openHub = async (userId: string): Promise<HubSocket> => {
  const res = await env.USER_HUB.getByName(userId).fetch("https://tempo.test/api/ws/hub", {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket (status ${res.status})`);
  const messages: any[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    messages.push(JSON.parse(String(e.data)));
  });
  ws.accept();
  return {
    ws,
    messages,
    status: res.status,
    close: () => {
      try {
        ws.close(1000, "done");
      } catch {
        // already closed
      }
    },
  };
};

const insertD1Workspace = async (
  seeded: Seeded,
  opts: {
    slug: string;
    rev: number;
    lastActivityAt: number;
    archivedAt?: number | null;
    state?: string;
    userId?: string;
  },
): Promise<string> => {
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, archived_at, summary_rev) VALUES (?, ?, ?, ?, ?, ?, 'main', ?, 'none', 'claude', 0, ?, ?, ?, ?)",
  )
    .bind(
      id,
      seeded.projectId,
      opts.userId ?? seeded.userId,
      opts.slug,
      opts.slug,
      `tempo/${opts.slug}`,
      opts.state ?? "ready",
      opts.lastActivityAt,
      opts.lastActivityAt,
      opts.archivedAt ?? null,
      opts.rev,
    )
    .run();
  return id;
};

const driveToReady = async (stub: DurableObjectStub<WorkspaceDO>): Promise<void> => {
  for (let i = 0; i < 15; i++) {
    await runDurableObjectAlarm(stub);
    const d = await stub.getWorkspace({});
    if (d.ok && (d.value.state === "ready" || d.value.state === "working")) return;
  }
  throw new Error("workspace did not become ready");
};

// ---------- CredentialDO ----------

describe("CredentialDO secrets", () => {
  it("round-trips putSecret/getSecret and returns null for a missing key", async () => {
    // 02 "CredentialDO and UserHubDO": getSecret(key) → "Plain value or null"; putSecret → {version}.
    const creds = credsFor(`user-${newId()}`);
    expect(await creds.getSecret("claude.oauth_token")).toBeNull();
    const put = await creds.putSecret("claude.oauth_token", "sk-ant-oat01-round-trip");
    expect(put).toEqual({ version: 1 });
    expect(await creds.getSecret("claude.oauth_token")).toBe("sk-ant-oat01-round-trip");
  });

  it("stores ciphertext at rest, never the plaintext, with a fresh 12-byte iv per write", async () => {
    // 02: "ciphertext BLOB NOT NULL, iv BLOB NOT NULL -- 12 random bytes per write"; 00: AES-256-GCM.
    const creds = credsFor(`user-${newId()}`);
    const plaintext = "sk-or-very-secret-value-0123456789";
    await creds.putSecret("openrouter.api_key", plaintext);
    const first = await rawSecret(creds, "openrouter.api_key");
    expect(first).toBeDefined();
    expect(first!.ciphertext).toBeInstanceOf(ArrayBuffer);
    expect(dec.decode(first!.ciphertext)).not.toContain(plaintext);
    // AES-GCM: same length as the plaintext plus a 16-byte tag.
    expect(first!.ciphertext.byteLength).toBe(enc.encode(plaintext).length + 16);
    expect(first!.iv.byteLength).toBe(12);
    // Nothing in the row (meta included) carries the value.
    expect(first!.meta_json).not.toContain(plaintext);

    await creds.putSecret("openrouter.api_key", plaintext);
    const second = await rawSecret(creds, "openrouter.api_key");
    expect(new Uint8Array(second!.iv)).not.toEqual(new Uint8Array(first!.iv));
    expect(new Uint8Array(second!.ciphertext)).not.toEqual(new Uint8Array(first!.ciphertext));
  });

  it("increments version on every write and updates updated_at", async () => {
    // 02: putSecret returns {version}; the secrets row has a version column (DEFAULT 1).
    const creds = credsFor(`user-${newId()}`);
    expect((await creds.putSecret("openai.api_key", "v1")).version).toBe(1);
    const r1 = await rawSecret(creds, "openai.api_key");
    expect((await creds.putSecret("openai.api_key", "v2")).version).toBe(2);
    expect((await creds.putSecret("openai.api_key", "v3")).version).toBe(3);
    const r3 = await rawSecret(creds, "openai.api_key");
    expect(r3!.version).toBe(3);
    expect(r3!.updated_at).toBeGreaterThanOrEqual(r1!.updated_at);
    expect(await creds.getSecret("openai.api_key")).toBe("v3");
    // Versions are per key.
    expect((await creds.putSecret("anthropic.api_key", "a")).version).toBe(1);
  });

  it("deleteSecret removes the value; deleting a missing key is a no-op", async () => {
    // 02: deleteSecret(key) → void.
    const creds = credsFor(`user-${newId()}`);
    await creds.putSecret("anthropic.api_key", "sk-ant-api");
    await creds.deleteSecret("anthropic.api_key");
    expect(await creds.getSecret("anthropic.api_key")).toBeNull();
    expect(await rawSecret(creds, "anthropic.api_key")).toBeUndefined();
    await expect(creds.deleteSecret("anthropic.api_key")).resolves.toBeUndefined();
    expect(await creds.status()).toEqual([]);
  });

  it("status() lists key, updatedAt and meta, and never values", async () => {
    // 02: status() → "[{key, updatedAt, meta}], never values"; meta_json "codex: {"lastRefresh": <ms>}".
    const creds = credsFor(`user-${newId()}`);
    const before = Date.now();
    await creds.putSecret("claude.oauth_token", "sk-ant-oat01-status-secret");
    await creds.putSecret("openrouter.api_key", "sk-or-status-secret");
    await creds.offerCodexAuth(
      codexAuth("2026-01-01T00:00:00Z", "codex-status-secret"),
      1_767_225_600_000,
      null,
    );
    const status = await creds.status();
    const text = JSON.stringify(status);
    expect(text).not.toContain("sk-ant-oat01-status-secret");
    expect(text).not.toContain("sk-or-status-secret");
    expect(text).not.toContain("codex-status-secret");
    expect(status.map((s: SecretStatus) => s.key).sort()).toEqual([
      "claude.oauth_token",
      "codex.auth_json",
      "openrouter.api_key",
    ]);
    for (const s of status) {
      expect(Object.keys(s).sort()).toEqual(["key", "meta", "updatedAt"]);
      expect(s.updatedAt).toBeGreaterThanOrEqual(before);
    }
    expect(status.find((s: SecretStatus) => s.key === "codex.auth_json")!.meta).toEqual({
      lastRefresh: 1_767_225_600_000,
    });
    expect(status.find((s: SecretStatus) => s.key === "claude.oauth_token")!.meta).toEqual({});
  });

  it("status() is empty for a user with no secrets", async () => {
    expect(await credsFor(`user-${newId()}`).status()).toEqual([]);
  });

  it("putSecret(key, value, meta) keeps meta and replaces it on the next write", async () => {
    // 02: putSecret(key, value, meta?) → {version}; meta_json DEFAULT '{}'.
    const creds = credsFor(`user-${newId()}`);
    await creds.putSecret("codex.auth_json", "{}", { lastRefresh: 42 });
    expect((await rawSecret(creds, "codex.auth_json"))!.meta_json).toBe('{"lastRefresh":42}');
    expect((await creds.status())[0]!.meta).toEqual({ lastRefresh: 42 });
    await creds.putSecret("codex.auth_json", "{}");
    expect((await creds.status())[0]!.meta).toEqual({});
  });
});

describe("CredentialDO encryption (02 Encryption, 05 Secrets)", () => {
  it("derives the key with HKDF-SHA256 (salt = user id, info = tempo-secrets-v1) and binds the key name as AAD", async () => {
    // 02 "Encryption": "Derive the AES-256-GCM key with HKDF-SHA256: salt = the user id, info = tempo-secrets-v1.
    // Use the secret's key name as additional authenticated data".
    const userId = `user-${newId()}`;
    const creds = credsFor(userId);
    await creds.putSecret("claude.oauth_token", "sk-ant-oat01-hkdf");
    const row = (await rawSecret(creds, "claude.oauth_token"))!;
    expect(await specOpen(userId, "claude.oauth_token", row)).toBe("sk-ant-oat01-hkdf");
    // Wrong salt or wrong AAD do not open it.
    await expect(specOpen(`user-${newId()}`, "claude.oauth_token", row)).rejects.toThrow();
    await expect(specOpen(userId, "openai.api_key", row)).rejects.toThrow();
  });

  it("uses a different key per instance: the same key name for two users gives ciphertexts that only their own instance opens", async () => {
    // 02 "Encryption": salt = the user id.
    const a = `user-${newId()}`;
    const b = `user-${newId()}`;
    await credsFor(a).putSecret("openai.api_key", "same-value");
    await credsFor(b).putSecret("openai.api_key", "same-value");
    const rowA = (await rawSecret(credsFor(a), "openai.api_key"))!;
    const rowB = (await rawSecret(credsFor(b), "openai.api_key"))!;
    expect(new Uint8Array(rowA.ciphertext)).not.toEqual(new Uint8Array(rowB.ciphertext));
    // Same iv, different salt → still not decryptable with the other user's key.
    await expect(specOpen(b, "openai.api_key", rowA)).rejects.toThrow();
    await expect(specOpen(a, "openai.api_key", rowB)).rejects.toThrow();
  });

  it("a row copied into another user's instance cannot be opened there (getSecret → null)", async () => {
    const a = credsFor(`user-${newId()}`);
    const b = credsFor(`user-${newId()}`);
    await a.putSecret("openrouter.api_key", "sk-or-copied");
    await b.status(); // runs b's migrations
    const row = (await rawSecret(a, "openrouter.api_key"))!;
    await writeRawSecret(b, row);
    expect(await b.getSecret("openrouter.api_key")).toBeNull();
    // Control: the same bytes written back into the owner's instance still open.
    await a.deleteSecret("openrouter.api_key");
    await writeRawSecret(a, row);
    expect(await a.getSecret("openrouter.api_key")).toBe("sk-or-copied");
  });

  it("a ciphertext moved to another key name in the same instance cannot be opened (AAD)", async () => {
    // 02 "Encryption": "so a ciphertext cannot be moved to another key".
    const creds = credsFor(`user-${newId()}`);
    await creds.putSecret("anthropic.api_key", "sk-ant-moved");
    const row = (await rawSecret(creds, "anthropic.api_key"))!;
    await writeRawSecret(creds, { ...row, key: "openai.api_key" });
    expect(await creds.getSecret("openai.api_key")).toBeNull();
    expect(await creds.getSecret("anthropic.api_key")).toBe("sk-ant-moved");
  });

  it("listProjectEnv skips a value that cannot be decrypted instead of failing", async () => {
    const creds = credsFor(`user-${newId()}`);
    const projectId = newId();
    await creds.putSecret(`project.${projectId}.env.GOOD`, "good");
    await creds.putSecret(`project.${projectId}.env.OTHER`, "other");
    const row = (await rawSecret(creds, `project.${projectId}.env.OTHER`))!;
    await writeRawSecret(creds, { ...row, key: `project.${projectId}.env.BAD` });
    expect(await creds.listProjectEnv(projectId)).toEqual({ GOOD: "good", OTHER: "other" });
  });
});

describe("CredentialDO project env", () => {
  it("listProjectEnv, listProjectEnvNames and deleteProjectEnv are scoped to one project id", async () => {
    // 02: key `project.<projectId>.env.<NAME>`; listProjectEnv(projectId) → {NAME: value} "for that project".
    const creds = credsFor(`user-${newId()}`);
    const p1 = newId();
    const p2 = newId();
    await creds.putSecret(`project.${p1}.env.DATABASE_URL`, "postgres://one");
    await creds.putSecret(`project.${p1}.env.API_TOKEN`, "tok-one");
    await creds.putSecret(`project.${p2}.env.DATABASE_URL`, "postgres://two");
    await creds.putSecret("claude.oauth_token", "sk-ant-oat01-not-project");

    expect(await creds.listProjectEnv(p1)).toEqual({ DATABASE_URL: "postgres://one", API_TOKEN: "tok-one" });
    expect(await creds.listProjectEnv(p2)).toEqual({ DATABASE_URL: "postgres://two" });
    expect(await creds.listProjectEnvNames(p1)).toEqual(["API_TOKEN", "DATABASE_URL"]);
    expect(await creds.listProjectEnvNames(p2)).toEqual(["DATABASE_URL"]);

    await creds.deleteProjectEnv(p1);
    expect(await creds.listProjectEnv(p1)).toEqual({});
    expect(await creds.listProjectEnvNames(p1)).toEqual([]);
    expect(await creds.listProjectEnv(p2)).toEqual({ DATABASE_URL: "postgres://two" });
    expect(await creds.getSecret("claude.oauth_token")).toBe("sk-ant-oat01-not-project");
  });

  it("does not match a project whose id only shares a prefix", async () => {
    const creds = credsFor(`user-${newId()}`);
    const p = newId();
    await creds.putSecret(`project.${p}x.env.NAME`, "other-project");
    await creds.putSecret(`project.${p}.env.NAME`, "mine");
    expect(await creds.listProjectEnv(p)).toEqual({ NAME: "mine" });
    await creds.deleteProjectEnv(p);
    expect(await creds.listProjectEnv(`${p}x`)).toEqual({ NAME: "other-project" });
  });

  it("returns empty results for an unknown project and deleting it is a no-op", async () => {
    const creds = credsFor(`user-${newId()}`);
    await creds.putSecret("openai.api_key", "k");
    expect(await creds.listProjectEnv(newId())).toEqual({});
    expect(await creds.listProjectEnvNames(newId())).toEqual([]);
    await expect(creds.deleteProjectEnv(newId())).resolves.toBeUndefined();
    expect(await creds.getSecret("openai.api_key")).toBe("k");
  });
});

describe("CredentialDO Codex auth.json", () => {
  it("getCodexAuth returns null when nothing is stored", async () => {
    // 02: getCodexAuth() → "{content, version, lastRefresh} or null".
    expect(await credsFor(`user-${newId()}`).getCodexAuth()).toBeNull();
  });

  it("getCodexAuth returns null when the stored auth.json cannot be decrypted", async () => {
    const a = credsFor(`user-${newId()}`);
    const b = credsFor(`user-${newId()}`);
    await a.offerCodexAuth(codexAuth("2026-03-01T00:00:00Z"), 1_000, null);
    await b.status();
    await writeRawSecret(b, (await rawSecret(a, "codex.auth_json"))!);
    expect(await b.getCodexAuth()).toBeNull();
  });

  it("offerCodexAuth stores the first offer and only later offers with a newer lastRefresh", async () => {
    // 01 "Codex auth.json sync" 4: "CredentialDO stores it only if lastRefresh is newer, then increments version."
    // 02: offerCodexAuth(content, lastRefresh, fromWorkspaceId) → {accepted, version}.
    const creds = credsFor(`user-${newId()}`);
    const first = codexAuth("2026-03-01T00:00:00Z");
    expect(await creds.offerCodexAuth(first, 1_000, null)).toEqual({ accepted: true, version: 1 });
    expect(await creds.getCodexAuth()).toEqual({ content: first, version: 1, lastRefresh: 1_000 });

    const older = codexAuth("2026-02-01T00:00:00Z");
    expect(await creds.offerCodexAuth(older, 500, null)).toEqual({ accepted: false, version: 1 });
    const same = codexAuth("2026-03-01T00:00:00Z");
    expect(await creds.offerCodexAuth(same, 1_000, null)).toEqual({ accepted: false, version: 1 });
    expect(await creds.getCodexAuth()).toEqual({ content: first, version: 1, lastRefresh: 1_000 });

    const newer = codexAuth("2026-04-01T00:00:00Z");
    expect(await creds.offerCodexAuth(newer, 2_000, "ws-x")).toEqual({ accepted: true, version: 2 });
    expect(await creds.getCodexAuth()).toEqual({ content: newer, version: 2, lastRefresh: 2_000 });
    const status = await creds.status();
    expect(status.find((s: SecretStatus) => s.key === "codex.auth_json")!.meta).toEqual({
      lastRefresh: 2_000,
    });
    // The stored auth.json is encrypted like every other secret.
    const row = (await rawSecret(creds, "codex.auth_json"))!;
    expect(dec.decode(row.ciphertext)).not.toContain("access_token");
  });

  it("replaceCodexAuth stores the owner's upload as is and increments version", async () => {
    // 02 Credentials: setCodexAuth {authJson}; 00 R5: "auth errors ask the user to upload again".
    const creds = credsFor(`user-${newId()}`);
    await creds.offerCodexAuth(codexAuth("2026-03-01T00:00:00Z"), 5_000, null);
    const upload = codexAuth("2026-01-01T00:00:00Z");
    expect(await creds.replaceCodexAuth(upload, 1_000)).toEqual({ version: 2 });
    expect(await creds.getCodexAuth()).toEqual({ content: upload, version: 2, lastRefresh: 1_000 });
  });

  it("addCodexLease is idempotent and dropCodexLease removes only that lease", async () => {
    // 02: codex_leases (workspace_id PRIMARY KEY, since); addCodexLease/dropCodexLease → void.
    const creds = credsFor(`user-${newId()}`);
    const w1 = newId();
    const w2 = newId();
    await creds.addCodexLease(w1);
    await creds.addCodexLease(w1);
    await creds.addCodexLease(w2);
    expect(await leaseRows(creds)).toEqual([w1, w2].sort());
    await creds.dropCodexLease(w1);
    expect(await leaseRows(creds)).toEqual([w2]);
    await expect(creds.dropCodexLease(newId())).resolves.toBeUndefined();
    expect(await leaseRows(creds)).toEqual([w2]);
  });

  it("offer succeeds even when a lease holder has no live tempod", async () => {
    // 01 "Codex auth.json sync" 5: push to every lease holder; a holder with no container must not break the offer.
    const creds = credsFor(`user-${newId()}`);
    await creds.addCodexLease(newId());
    await creds.addCodexLease(newId());
    expect(await creds.offerCodexAuth(codexAuth("2026-05-01T00:00:00Z"), 10, null)).toEqual({
      accepted: true,
      version: 1,
    });
    expect(await creds.replaceCodexAuth(codexAuth("2026-05-02T00:00:00Z"), 20)).toEqual({ version: 2 });
  });

  it("pushes an accepted offer to every lease holder except the sender, and an upload to every lease holder", async () => {
    // 01 "Codex auth.json sync" 5: "CredentialDO calls pushCodexAuth on every WorkspaceDO that holds a lease,
    // except the sender. Each sends credential.put to its tempod." Step 1: credential.put {provider: "codex", content, version}.
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const a = await seedWorkspace(seeded, { slug: `alpha${seeded.repoId}` });
    const b = await seedWorkspace(seeded, { slug: `bravo${seeded.repoId}` });
    const c = await seedWorkspace(seeded, { slug: `charlie${seeded.repoId}` });
    await driveToReady(a.stub);
    await driveToReady(b.stub);
    await driveToReady(c.stub);
    await waitFor(
      () => a.tempod.connected && b.tempod.connected && c.tempod.connected,
      5000,
      "tempod connections",
    );
    expect(a.tempod.requestsOf("credential.put")).toHaveLength(0);
    expect(b.tempod.requestsOf("credential.put")).toHaveLength(0);

    const creds = credsFor(seeded.userId);
    await creds.addCodexLease(a.workspaceId);
    await creds.addCodexLease(b.workspaceId);
    await creds.addCodexLease(c.workspaceId);
    await creds.dropCodexLease(c.workspaceId);
    // A lease whose workspace has no live tempod does not stop the others.
    await creds.addCodexLease(newId());

    const content = codexAuth("2026-06-01T00:00:00Z");
    const res = await creds.offerCodexAuth(content, 1_000, a.workspaceId);
    expect(res).toEqual({ accepted: true, version: 1 });
    await waitFor(() => b.tempod.requestsOf("credential.put").length === 1, 5000, "push to b");
    expect(b.tempod.requestsOf("credential.put")[0]).toEqual({ provider: "codex", content, version: 1 });

    // A rejected (older) offer pushes nothing.
    expect((await creds.offerCodexAuth(codexAuth("2026-05-01T00:00:00Z"), 500, b.workspaceId)).accepted).toBe(
      false,
    );

    // The owner's upload goes to every lease holder, the former sender included.
    const upload = codexAuth("2026-07-01T00:00:00Z");
    expect(await creds.replaceCodexAuth(upload, 2_000)).toEqual({ version: 2 });
    await waitFor(
      () =>
        a.tempod.requestsOf("credential.put").length === 1 &&
        b.tempod.requestsOf("credential.put").length === 2,
      5000,
      "push of the upload",
    );
    expect(a.tempod.requestsOf("credential.put")[0]).toEqual({
      provider: "codex",
      content: upload,
      version: 2,
    });
    expect(b.tempod.requestsOf("credential.put")[1]).toEqual({
      provider: "codex",
      content: upload,
      version: 2,
    });
    // The sender never got its own offer back, the old offer was not pushed, and the dropped lease got nothing.
    expect(a.tempod.requestsOf("credential.put")).toHaveLength(1);
    expect(b.tempod.requestsOf("credential.put")).toHaveLength(2);
    expect(c.tempod.requestsOf("credential.put")).toHaveLength(0);

    // An offer with no sender reaches every lease holder.
    const fresh = codexAuth("2026-08-01T00:00:00Z");
    expect(await creds.offerCodexAuth(fresh, 3_000, null)).toEqual({ accepted: true, version: 3 });
    await waitFor(
      () =>
        a.tempod.requestsOf("credential.put").length === 2 &&
        b.tempod.requestsOf("credential.put").length === 3,
      5000,
      "push of a sender-less offer",
    );
    expect(a.tempod.requestsOf("credential.put")[1]).toEqual({
      provider: "codex",
      content: fresh,
      version: 3,
    });
    expect(b.tempod.requestsOf("credential.put")[2]).toEqual({
      provider: "codex",
      content: fresh,
      version: 3,
    });
    expect(c.tempod.requestsOf("credential.put")).toHaveLength(0);
  });
});

describe("CredentialDO system instance (02, 05 Secrets)", () => {
  const config = {
    appId: "123456",
    slug: "tempo-test-app",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEtest\n-----END RSA PRIVATE KEY-----",
    clientId: "Iv1.abcdef",
    clientSecret: "client-secret-value",
  };

  it("returns null before setup, then round-trips the GitHub App config under the exact keys with salt `system`", async () => {
    // 02: getGithubAppConfig() → "{appId, slug, privateKey, clientId, clientSecret} or null. On the system instance only."
    // 05 Secrets: keys github_app.id, github_app.slug, github_app.private_key, github_app.client_id, github_app.client_secret;
    // "The system CredentialDO derives its key with salt system instead of a user id."
    const system = credsFor("system");
    expect(await system.getGithubAppConfig()).toBeNull();
    await system.putGithubAppConfig(config);
    expect(await system.getGithubAppConfig()).toEqual(config);
    expect((await system.status()).map((s: SecretStatus) => s.key).sort()).toEqual([
      "github_app.client_id",
      "github_app.client_secret",
      "github_app.id",
      "github_app.private_key",
      "github_app.slug",
    ]);
    const pem = (await rawSecret(system, "github_app.private_key"))!;
    expect(dec.decode(pem.ciphertext)).not.toContain("PRIVATE KEY");
    expect(await specOpen("system", "github_app.private_key", pem)).toBe(config.privateKey);
    const secret = (await rawSecret(system, "github_app.client_secret"))!;
    expect(await specOpen("system", "github_app.client_secret", secret)).toBe(config.clientSecret);

    // An incomplete config reads as null.
    const slugRow = (await rawSecret(system, "github_app.slug"))!;
    await system.deleteSecret("github_app.slug");
    expect(await system.getGithubAppConfig()).toBeNull();
    await writeRawSecret(system, slugRow);
    expect(await system.getGithubAppConfig()).toEqual(config);
  });

  it("a user instance refuses getGithubAppConfig and putGithubAppConfig", async () => {
    // 02: getGithubAppConfig "On the system instance only".
    // Called on the instance: a throwing RPC call is reported by the pool as an unhandled rejection.
    const user = credsFor(`user-${newId()}`);
    await runInDurableObject(user, async (i: unknown) => {
      const instance = i as CredentialDO;
      await expect(instance.getGithubAppConfig()).rejects.toThrow(/system/);
      await expect(instance.putGithubAppConfig(config)).rejects.toThrow(/system/);
    });
    expect(await user.status()).toEqual([]);
  });
});

// ---------- UserHubDO ----------

describe("UserHubDO", () => {
  it("accepts a WebSocket upgrade with 101 and sends hello {v:1, workspaces: []} for a user with nothing", async () => {
    // 02 "Hub channel": hello → "v: 1, workspaces: WorkspaceSummary[]".
    const hub = await openHub(`user-${newId()}`);
    expect(hub.status).toBe(101);
    await waitFor(() => hub.messages.length >= 1, 3000, "hello");
    expect(hub.messages[0]).toEqual({ type: "hello", v: 1, workspaces: [] });
    hub.close();
  });

  it("refuses a request without an Upgrade header", async () => {
    const res = await env.USER_HUB.getByName(`user-${newId()}`).fetch("https://tempo.test/api/ws/hub");
    expect(res.status).not.toBe(101);
    expect(res.webSocket).toBeNull();
  });

  it("publish stores a summary that the next hello carries", async () => {
    // 02 UserHubDO: "publish(summary) stores the summary if rev is newer"; "On a new socket, send hello with every stored summary."
    const userId = `user-${newId()}`;
    const hub = env.USER_HUB.getByName(userId);
    const s1 = summary({ slug: "lima", rev: 3 });
    const s2 = summary({ slug: "oslo", rev: 1 });
    await hub.publish(s1);
    await hub.publish(s2);
    const sock = await openHub(userId);
    await waitFor(() => sock.messages.length >= 1, 3000, "hello");
    expect(sock.messages[0].type).toBe("hello");
    expect(sock.messages[0].v).toBe(1);
    const byId = new Map((sock.messages[0].workspaces as WorkspaceSummary[]).map((w) => [w.id, w]));
    expect(byId.size).toBe(2);
    expect(byId.get(s1.id)).toEqual(s1);
    expect(byId.get(s2.id)).toEqual(s2);
    sock.close();
  });

  it("publish ignores a summary whose rev is not newer, and does not broadcast it", async () => {
    // 02 UserHubDO: "publish(summary) stores the summary if rev is newer and sends it to every socket."
    const userId = `user-${newId()}`;
    const hub = env.USER_HUB.getByName(userId);
    const id = newId();
    const v5 = summary({ id, title: "rev five", rev: 5 });
    await hub.publish(v5);
    const sock = await openHub(userId);
    await waitFor(() => sock.messages.length >= 1, 3000, "hello");

    await hub.publish(summary({ id, title: "rev five again", rev: 5 }));
    await hub.publish(summary({ id, title: "rev four", rev: 4 }));
    const v6 = summary({ id, title: "rev six", rev: 6 });
    await hub.publish(v6);
    await waitFor(() => sock.messages.length >= 2, 3000, "workspace message");
    // Only the newer one was sent: the socket preserves order, so a stale publish would have arrived first.
    expect(sock.messages.slice(1)).toEqual([{ type: "workspace", summary: v6 }]);

    const second = await openHub(userId);
    await waitFor(() => second.messages.length >= 1, 3000, "hello");
    expect(second.messages[0].workspaces).toEqual([v6]);
    sock.close();
    second.close();
  });

  it("broadcasts workspace and workspace.removed to every live socket; remove deletes the stored summary", async () => {
    // 02 UserHubDO: "remove(workspaceId) deletes the stored summary and sends workspace.removed to every socket."
    const userId = `user-${newId()}`;
    const hub = env.USER_HUB.getByName(userId);
    const keep = summary({ slug: "rome", rev: 1 });
    await hub.publish(keep);
    const s1 = await openHub(userId);
    const s2 = await openHub(userId);
    await waitFor(() => s1.messages.length >= 1 && s2.messages.length >= 1, 3000, "hellos");

    const added = summary({ slug: "kyiv", rev: 2 });
    await hub.publish(added);
    await hub.remove(added.id);
    await waitFor(() => s1.messages.length >= 3 && s2.messages.length >= 3, 3000, "broadcasts");
    for (const s of [s1, s2]) {
      expect(s.messages.slice(1)).toEqual([
        { type: "workspace", summary: added },
        { type: "workspace.removed", workspaceId: added.id },
      ]);
    }

    const s3 = await openHub(userId);
    await waitFor(() => s3.messages.length >= 1, 3000, "hello");
    expect(s3.messages[0].workspaces).toEqual([keep]);
    for (const s of [s1, s2, s3]) s.close();
  });

  it("remove of an unknown workspace still tells live sockets and leaves other summaries alone", async () => {
    const userId = `user-${newId()}`;
    const hub = env.USER_HUB.getByName(userId);
    const keep = summary({ rev: 1 });
    await hub.publish(keep);
    const sock = await openHub(userId);
    await waitFor(() => sock.messages.length >= 1, 3000, "hello");
    const ghost = newId();
    await hub.remove(ghost);
    await waitFor(() => sock.messages.length >= 2, 3000, "removed");
    expect(sock.messages[1]).toEqual({ type: "workspace.removed", workspaceId: ghost });
    const again = await openHub(userId);
    await waitFor(() => again.messages.length >= 1, 3000, "hello");
    expect(again.messages[0].workspaces).toEqual([keep]);
    sock.close();
    again.close();
  });

  it("does not send to sockets of another user's hub", async () => {
    // 00: UserHubDO is "1 per user"; 02: named by the Better Auth user id.
    const u1 = `user-${newId()}`;
    const u2 = `user-${newId()}`;
    const other = await openHub(u2);
    await waitFor(() => other.messages.length >= 1, 3000, "hello");
    await env.USER_HUB.getByName(u1).publish(summary({ rev: 1 }));
    await env.USER_HUB.getByName(u1).remove(newId());
    // A message to u2 afterwards proves ordering; nothing from u1 arrived before it.
    const mine = summary({ rev: 1 });
    await env.USER_HUB.getByName(u2).publish(mine);
    await waitFor(() => other.messages.length >= 2, 3000, "u2 message");
    expect(other.messages.slice(1)).toEqual([{ type: "workspace", summary: mine }]);
    other.close();
  });

  it("answers ping with pong", async () => {
    // 02 "Hub channel": "The client sends only {"type":"ping"}"; server message `pong`.
    const sock = await openHub(`user-${newId()}`);
    await waitFor(() => sock.messages.length >= 1, 3000, "hello");
    sock.ws.send(JSON.stringify({ type: "ping" }));
    await waitFor(() => sock.messages.length >= 2, 3000, "pong");
    expect(sock.messages[1]).toEqual({ type: "pong" });
    sock.close();
  });

  it("loads summaries from D1 once when its table is empty", async () => {
    // 02 UserHubDO: "On a new socket, send hello with every stored summary. If the table is empty, load it once from D1 first."
    const seeded = await seedProject();
    const otherUser = await seedProject();
    const w1 = await insertD1Workspace(seeded, { slug: "tokyo", rev: 4, lastActivityAt: 2_000 });
    const w2 = await insertD1Workspace(seeded, {
      slug: "seoul",
      rev: 7,
      lastActivityAt: 3_000,
      state: "sleeping",
    });
    await insertD1Workspace(otherUser, { slug: "lagos", rev: 1, lastActivityAt: 4_000 });

    const first = await openHub(seeded.userId);
    await waitFor(() => first.messages.length >= 1, 3000, "hello");
    const hello = first.messages[0];
    expect(hello.type).toBe("hello");
    expect(hello.v).toBe(1);
    const byId = new Map((hello.workspaces as WorkspaceSummary[]).map((w) => [w.id, w]));
    expect([...byId.keys()].sort()).toEqual([w1, w2].sort());
    expect(byId.get(w2)).toEqual({
      id: w2,
      projectId: seeded.projectId,
      slug: "seoul",
      title: "seoul",
      branch: "tempo/seoul",
      baseBranch: "main",
      state: "sleeping",
      attention: "none",
      defaultAgent: "claude",
      prNumber: null,
      prState: null,
      checksState: null,
      pinned: false,
      lastActivityAt: 3_000,
      createdAt: 3_000,
      archivedAt: null,
      rev: 7,
    });
    // The loaded summaries are now stored: a publish with an older rev is ignored.
    await env.USER_HUB.getByName(seeded.userId).publish({ ...byId.get(w1)!, title: "stale", rev: 3 });

    // A later D1 row is not picked up: the hub loaded once and now serves its own table.
    await insertD1Workspace(seeded, { slug: "hanoi", rev: 1, lastActivityAt: 5_000 });
    const second = await openHub(seeded.userId);
    await waitFor(() => second.messages.length >= 1, 3000, "hello");
    const ids = (second.messages[0].workspaces as WorkspaceSummary[]).map((w) => w.id).sort();
    expect(ids).toEqual([w1, w2].sort());
    expect((second.messages[0].workspaces as WorkspaceSummary[]).find((w) => w.id === w1)!.title).toBe(
      "tokyo",
    );
    // The stale publish was not broadcast.
    expect(first.messages).toHaveLength(1);
    first.close();
    second.close();
  });

  it("does not load archived workspaces from D1", async () => {
    // 03 Archive: "call UserHubDO.remove(workspaceId), so every open sidebar drops the workspace" — archived
    // workspaces are not in the sidebar.
    const seeded = await seedProject();
    const live = await insertD1Workspace(seeded, { slug: "cairo", rev: 1, lastActivityAt: 1_000 });
    await insertD1Workspace(seeded, {
      slug: "dakar",
      rev: 2,
      lastActivityAt: 2_000,
      archivedAt: 3_000,
      state: "archived",
    });
    const sock = await openHub(seeded.userId);
    await waitFor(() => sock.messages.length >= 1, 3000, "hello");
    expect((sock.messages[0].workspaces as WorkspaceSummary[]).map((w) => w.id)).toEqual([live]);
    sock.close();
  });

  it("does not consult D1 when it already holds summaries", async () => {
    const seeded = await seedProject();
    await insertD1Workspace(seeded, { slug: "quito", rev: 1, lastActivityAt: 1_000 });
    const published = summary({ projectId: seeded.projectId, slug: "lima", rev: 1 });
    await env.USER_HUB.getByName(seeded.userId).publish(published);
    const sock = await openHub(seeded.userId);
    await waitFor(() => sock.messages.length >= 1, 3000, "hello");
    expect(sock.messages[0].workspaces).toEqual([published]);
    sock.close();
  });
});
