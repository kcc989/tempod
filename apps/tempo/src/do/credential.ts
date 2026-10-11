import { DurableObject } from "cloudflare:workers";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { eq, like } from "drizzle-orm";
import { credentialSchema, codexLeases, secrets } from "../db/credential-do.ts";
import { CREDENTIAL_MIGRATIONS, runMigrations } from "../db/do-migrations.ts";
import type { Env } from "../env.ts";
import { deriveKey, open, seal } from "../lib/crypto.ts";
import { log } from "../log.ts";

export const SYSTEM_CREDENTIALS = "system";

export const SECRET_KEYS = {
  claude: "claude.oauth_token",
  codex: "codex.auth_json",
  openrouter: "openrouter.api_key",
  anthropic: "anthropic.api_key",
  openai: "openai.api_key",
} as const;

export const projectEnvKey = (projectId: string, name: string) => `project.${projectId}.env.${name}`;

export const GITHUB_APP_KEYS = {
  id: "github_app.id",
  slug: "github_app.slug",
  privateKey: "github_app.private_key",
  clientId: "github_app.client_id",
  clientSecret: "github_app.client_secret",
} as const;

export interface GithubAppConfig {
  readonly appId: string;
  readonly slug: string;
  readonly privateKey: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SecretStatus {
  readonly key: string;
  readonly updatedAt: number;
  readonly meta: { readonly lastRefresh?: number };
}

/**
 * The only place secrets are stored (02, CredentialDO). One per user, named by the user id,
 * plus one named `system` for the GitHub App config.
 */
export class CredentialDO extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase<typeof credentialSchema>;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema: credentialSchema });
    void ctx.blockConcurrencyWhile(() => runMigrations(this.db, CREDENTIAL_MIGRATIONS));
  }

  private get name(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("CredentialDO must be addressed by name");
    return name;
  }

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= deriveKey(this.env.TEMPO_ENCRYPTION_KEY, this.name);
    return this.keyPromise;
  }

  async getSecret(key: string): Promise<string | null> {
    const row = this.db.select().from(secrets).where(eq(secrets.key, key)).get();
    if (!row) return null;
    try {
      return await open(await this.key(), key, { ciphertext: row.ciphertext, iv: row.iv });
    } catch {
      log("warn", "secret could not be decrypted", { secret: key });
      return null;
    }
  }

  async putSecret(key: string, value: string, meta: Record<string, unknown> = {}): Promise<{ version: number }> {
    const sealed = await seal(await this.key(), key, value);
    const now = Date.now();
    const prev = this.db.select({ version: secrets.version }).from(secrets).where(eq(secrets.key, key)).get();
    const version = (prev?.version ?? 0) + 1;
    this.db
      .insert(secrets)
      .values({ key, ciphertext: sealed.ciphertext, iv: sealed.iv, version, metaJson: JSON.stringify(meta), updatedAt: now })
      .onConflictDoUpdate({
        target: secrets.key,
        set: { ciphertext: sealed.ciphertext, iv: sealed.iv, version, metaJson: JSON.stringify(meta), updatedAt: now },
      })
      .run();
    return { version };
  }

  async deleteSecret(key: string): Promise<void> {
    this.db.delete(secrets).where(eq(secrets.key, key)).run();
  }

  async status(): Promise<SecretStatus[]> {
    return this.db
      .select({ key: secrets.key, updatedAt: secrets.updatedAt, metaJson: secrets.metaJson })
      .from(secrets)
      .all()
      .map((r) => ({ key: r.key, updatedAt: r.updatedAt, meta: JSON.parse(r.metaJson) as { lastRefresh?: number } }));
  }

  async listProjectEnv(projectId: string): Promise<Record<string, string>> {
    const prefix = `project.${projectId}.env.`;
    const rows = this.db.select({ key: secrets.key }).from(secrets).where(like(secrets.key, `${prefix}%`)).all();
    const out: Record<string, string> = {};
    for (const r of rows) {
      const value = await this.getSecret(r.key);
      if (value !== null) out[r.key.slice(prefix.length)] = value;
    }
    return out;
  }

  async listProjectEnvNames(projectId: string): Promise<string[]> {
    const prefix = `project.${projectId}.env.`;
    return this.db
      .select({ key: secrets.key })
      .from(secrets)
      .where(like(secrets.key, `${prefix}%`))
      .all()
      .map((r) => r.key.slice(prefix.length))
      .sort();
  }

  async deleteProjectEnv(projectId: string): Promise<void> {
    this.db.delete(secrets).where(like(secrets.key, `project.${projectId}.env.%`)).run();
  }

  /** Stores a Codex auth.json only if it is newer, then pushes it to every other lease holder (01). */
  async offerCodexAuth(
    content: string,
    lastRefresh: number,
    fromWorkspaceId: string | null,
  ): Promise<{ accepted: boolean; version: number }> {
    const row = this.db.select().from(secrets).where(eq(secrets.key, SECRET_KEYS.codex)).get();
    const current = row ? (JSON.parse(row.metaJson) as { lastRefresh?: number }).lastRefresh ?? 0 : -1;
    if (row && !(lastRefresh > current)) return { accepted: false, version: row.version };
    const { version } = await this.putSecret(SECRET_KEYS.codex, content, { lastRefresh });
    const leases = this.db.select().from(codexLeases).all();
    for (const lease of leases) {
      if (lease.workspaceId === fromWorkspaceId) continue;
      this.ctx.waitUntil(
        this.env.WORKSPACE.getByName(lease.workspaceId)
          .pushCodexAuth(content, version)
          .catch(() => log("warn", "codex auth push failed", { workspaceId: lease.workspaceId })),
      );
    }
    return { accepted: true, version };
  }

  /** The owner uploaded a new auth.json: store it as is and push it to every lease holder. */
  async replaceCodexAuth(content: string, lastRefresh: number): Promise<{ version: number }> {
    const { version } = await this.putSecret(SECRET_KEYS.codex, content, { lastRefresh });
    for (const lease of this.db.select().from(codexLeases).all()) {
      this.ctx.waitUntil(
        this.env.WORKSPACE.getByName(lease.workspaceId)
          .pushCodexAuth(content, version)
          .catch(() => log("warn", "codex auth push failed", { workspaceId: lease.workspaceId })),
      );
    }
    return { version };
  }

  async getCodexAuth(): Promise<{ content: string; version: number; lastRefresh: number } | null> {
    const row = this.db.select().from(secrets).where(eq(secrets.key, SECRET_KEYS.codex)).get();
    if (!row) return null;
    const content = await this.getSecret(SECRET_KEYS.codex);
    if (content === null) return null;
    const meta = JSON.parse(row.metaJson) as { lastRefresh?: number };
    return { content, version: row.version, lastRefresh: meta.lastRefresh ?? 0 };
  }

  async addCodexLease(workspaceId: string): Promise<void> {
    this.db.insert(codexLeases).values({ workspaceId, since: Date.now() }).onConflictDoNothing().run();
  }

  async dropCodexLease(workspaceId: string): Promise<void> {
    this.db.delete(codexLeases).where(eq(codexLeases.workspaceId, workspaceId)).run();
  }

  async getGithubAppConfig(): Promise<GithubAppConfig | null> {
    if (this.name !== SYSTEM_CREDENTIALS) throw new Error("getGithubAppConfig is for the system instance only");
    const [appId, slug, privateKey, clientId, clientSecret] = await Promise.all([
      this.getSecret(GITHUB_APP_KEYS.id),
      this.getSecret(GITHUB_APP_KEYS.slug),
      this.getSecret(GITHUB_APP_KEYS.privateKey),
      this.getSecret(GITHUB_APP_KEYS.clientId),
      this.getSecret(GITHUB_APP_KEYS.clientSecret),
    ]);
    if (!appId || !slug || !privateKey || !clientId || !clientSecret) return null;
    return { appId, slug, privateKey, clientId, clientSecret };
  }

  async putGithubAppConfig(config: GithubAppConfig): Promise<void> {
    if (this.name !== SYSTEM_CREDENTIALS) throw new Error("putGithubAppConfig is for the system instance only");
    await this.putSecret(GITHUB_APP_KEYS.id, config.appId);
    await this.putSecret(GITHUB_APP_KEYS.slug, config.slug);
    await this.putSecret(GITHUB_APP_KEYS.privateKey, config.privateKey);
    await this.putSecret(GITHUB_APP_KEYS.clientId, config.clientId);
    await this.putSecret(GITHUB_APP_KEYS.clientSecret, config.clientSecret);
  }
}
