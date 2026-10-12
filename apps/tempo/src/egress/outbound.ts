import { WorkerEntrypoint } from "cloudflare:workers";
import { SECRET_KEYS } from "../do/credential.ts";
import type { Env } from "../env.ts";
import { BROWSER_CDP_HEADER, stripInternalHeaders } from "../http/preview.ts";
import { log } from "../log.ts";
import { decide, type EgressConfig } from "./rules.ts";

export interface OutboundProps {
  readonly workspaceId: string;
  readonly userId: string;
  readonly catalog?: boolean;
}

const CONFIG_TTL_MS = 60_000;
const configCache = new Map<string, { config: EgressConfig; at: number }>();

/**
 * The container's only way out (01, Credentials and egress). Adds GitHub and API-key
 * credentials, enforces the egress policy, and logs every request. Never buffers bodies.
 */
export class TempoOutbound extends WorkerEntrypoint<Env, OutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const { workspaceId, userId } = this.ctx.props;
    const workspace = this.env.WORKSPACE.getByName(workspaceId);
    let rule = 10;
    let status = 0;
    try {
      const config: EgressConfig = this.ctx.props.catalog
        ? { owner: "", repo: "", policy: "allowlist", allowlist: [], mcp: [] }
        : await this.config(workspaceId);
      const decision = decide(url, request.headers, this.env.APP_HOST, config);
      rule = decision.rule;
      if (decision.action === "browser") {
        // Rule 11 (01, Browser Run): the WorkspaceDO joins the CDP socket to its Browser Run session.
        const headers = stripInternalHeaders(new Headers(request.headers));
        headers.set(BROWSER_CDP_HEADER, "1");
        const response = await workspace.fetch(new Request(request, { headers }));
        status = response.status;
        return response;
      }
      if (decision.action === "block") {
        status = decision.status;
        return new Response(decision.body, { status: decision.status });
      }
      const headers = new Headers(request.headers);
      if (decision.set) {
        const value = await this.credential(decision.set.value, workspace, userId);
        if (value === null) {
          status = 403;
          return new Response("tempo: credential not set", { status: 403 });
        }
        headers.set(decision.set.name, value);
      }
      if (decision.mcp) {
        const creds = this.env.CREDENTIALS.getByName(userId);
        for (const swap of decision.mcp) {
          const value = await creds.getSecret(swap.key);
          if (value === null) {
            status = 403;
            return new Response("tempo: credential not set", { status: 403 });
          }
          headers.set(swap.name, value);
        }
      }
      const response = await fetch(new Request(request, { headers }));
      status = response.status;
      return response;
    } catch (e) {
      status = 502;
      log("warn", "egress fetch failed", { workspaceId, host: url.hostname, rule });
      return new Response(`tempo: upstream error for ${url.hostname}`, { status: 502 });
    } finally {
      if (!this.ctx.props.catalog)
        this.ctx.waitUntil(
          workspace
            .logEgress({
              ts: started,
              method: request.method,
              host: url.hostname,
              path: url.pathname,
              status,
              ms: Date.now() - started,
              rule,
            })
            .catch(() => undefined),
        );
    }
  }

  private async config(workspaceId: string): Promise<EgressConfig> {
    const hit = configCache.get(workspaceId);
    if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.config;
    const config = await this.env.WORKSPACE.getByName(workspaceId).getEgressConfig();
    configCache.set(workspaceId, { config, at: Date.now() });
    return config;
  }

  private async credential(
    kind: "github-basic" | "github-bearer" | "openrouter" | "anthropic" | "openai",
    workspace: DurableObjectStub<import("../do/workspace/index.ts").WorkspaceDO>,
    userId: string,
  ): Promise<string | null> {
    if (kind === "github-basic" || kind === "github-bearer") {
      const token = await workspace.getGithubToken();
      if (!token) return null;
      return kind === "github-basic" ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`;
    }
    const creds = this.env.CREDENTIALS.getByName(userId);
    const key = await creds.getSecret(SECRET_KEYS[kind]);
    if (key === null) return null;
    return kind === "anthropic" ? key : `Bearer ${key}`;
  }
}
