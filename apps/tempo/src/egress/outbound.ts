import { WorkerEntrypoint } from "cloudflare:workers";
import type { Injector } from "@tempo/protocol";
import { SECRET_KEYS } from "../do/credential.ts";
import type { Env } from "../env.ts";
import { BROWSER_CDP_HEADER, stripInternalHeaders } from "../http/preview.ts";
import { environmentSecretKey } from "../lib/environments.ts";
import { log } from "../log.ts";
import { decide, decideForInjector, swapSecrets, type Decision, type EgressConfig } from "./rules.ts";

export interface OutboundProps {
  readonly workspaceId: string;
  readonly userId: string;
  readonly catalog?: boolean;
  /** A CI job's container (10, Egress). */
  readonly ci?: boolean;
  /** A deployment's container (12, Egress). */
  readonly deploy?: boolean;
  /** Set for a subrequest of this injector (01, rule 13). */
  readonly injector?: string;
}

const CONFIG_TTL_MS = 60_000;

const INJECTOR_COMPATIBILITY_DATE = "2026-08-01";

const configCache = new Map<string, { config: EgressConfig; at: number }>();

const block = (status: number, body: string) => new Response(body, { status });

/**
 * The container's only way out (01, Credentials and egress). Adds GitHub and API-key
 * credentials, swaps environment secrets, runs injectors, enforces the egress policy, and logs
 * every request. Never buffers bodies.
 */
export class TempoOutbound extends WorkerEntrypoint<Env, OutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const { workspaceId, userId, injector: injectorName } = this.ctx.props;
    const workspace = this.env.WORKSPACE.getByName(workspaceId);
    let rule = injectorName ? 13 : 10;
    let status = 0;

    try {
      const config: EgressConfig = this.ctx.props.catalog
        ? { owner: "", repo: "", policy: "allowlist", allowlist: [], mcp: [] }
        : await this.config(workspaceId);

      let decision: Decision;

      if (this.ctx.props.ci && !config.ci) {
        decision = { rule: 10, action: "block", status: 403, body: "tempo: CI job not found" };
      } else if (Boolean(this.ctx.props.deploy) !== Boolean(config.deploy)) {
        decision = { rule: 10, action: "block", status: 403, body: "tempo: deployment not found" };
      } else if (injectorName) {
        const injector = config.injectors?.find((i) => i.name === injectorName);
        decision = injector
          ? decideForInjector(url, request.headers, this.env.APP_HOST, config, injector)
          : { rule: 13, action: "block", status: 403, body: `tempo: egress blocked for ${url.hostname}` };
      } else {
        decision = decide(url, request.headers, this.env.APP_HOST, config);
      }

      rule = decision.rule;
      const acted = await this.act(decision, request, config, userId, workspace);
      rule = acted.rule ?? rule;
      status = acted.response.status;

      return acted.response;
    } catch {
      status = 502;
      log("warn", "egress fetch failed", { workspaceId, host: url.hostname, rule });

      return block(502, `tempo: upstream error for ${url.hostname}`);
    } finally {
      if (this.ctx.props.ci)
        log("info", "ci egress", { runner: workspaceId, host: url.hostname, status, rule });
      else if (this.ctx.props.deploy)
        log("info", "deploy egress", { runner: workspaceId, host: url.hostname, status, rule });
      else if (!this.ctx.props.catalog)
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
  /** Carries out a decision. `rule` is set when the logged rule differs from the decision's. */
  private async act(
    decision: Decision,
    request: Request,
    config: EgressConfig,
    userId: string,
    workspace: DurableObjectStub<import("../do/workspace/index.ts").WorkspaceDO>,
  ): Promise<{ response: Response; rule?: number }> {
    switch (decision.action) {
      case "browser": {
        // Rule 11 (01, Browser Run): the WorkspaceDO joins the CDP socket to its Browser Run session.
        const headers = stripInternalHeaders(new Headers(request.headers));
        headers.set(BROWSER_CDP_HEADER, "1");

        return { response: await workspace.fetch(new Request(request, { headers })) };
      }

      case "block":
        return { response: block(decision.status, decision.body) };
      case "inject":
        return { response: await this.runInjector(decision.injector, request, config) };
      case "swap": {
        const values = await this.environmentSecrets(config, decision.names, userId);

        if (!values) return { response: block(403, "tempo: placeholder credential refused"), rule: 7 };
        const swapped = swapSecrets(new URL(request.url), request.headers, values);
        // Manual redirects, so a redirect cannot carry the value to another host (01, rule 14).
        const init = new Request(request, { headers: swapped.headers, redirect: "manual" });

        return { response: await fetch(new Request(swapped.url, init)) };
      }

      case "forward": {
        if (!decision.set && !decision.mcp) return { response: await fetch(request) };
        const headers = new Headers(request.headers);

        const repoBearer =
          decision.set?.value === "artifact-bearer" ||
          decision.set?.value === "dotfiles-bearer" ||
          decision.set?.value === "deploy-bearer";

        if (repoBearer) {
          for (const name of ["authorization", "proxy-authorization", "cookie", "x-api-key"])
            headers.delete(name);
        }

        if (decision.set) {
          const value = await this.credential(decision.set.value, userId);

          if (value === null) return { response: block(403, "tempo: credential not set") };
          headers.set(decision.set.name, value);
        }

        if (decision.mcp) {
          // Rule 12 (01, User MCP servers).
          const creds = this.env.CREDENTIALS.getByName(userId);

          for (const swap of decision.mcp) {
            const value = await creds.getSecret(swap.key);

            if (value === null) return { response: block(403, "tempo: credential not set") };
            headers.set(swap.name, value);
          }
        }

        const init: RequestInit = { headers };

        if (repoBearer) init.redirect = "manual";

        return { response: await fetch(new Request(request, init)) };
      }
    }
  }
  private async environmentSecrets(
    config: EgressConfig,
    names: ReadonlyArray<string>,
    userId: string,
  ): Promise<Record<string, string> | null> {
    if (!config.environmentId) return null;
    const creds = this.env.CREDENTIALS.getByName(userId);
    const out: Record<string, string> = {};

    for (const name of names) {
      const value = await creds.getSecret(environmentSecretKey(config.environmentId, name));

      if (value === null) return null;
      out[name] = value;
    }

    return out;
  }
  /** Rule 13: the owner-approved injector runs as a Dynamic Worker (01, Environments). */
  private async runInjector(injector: Injector, request: Request, config: EgressConfig): Promise<Response> {
    const { workspaceId, userId } = this.ctx.props;
    const environmentId = config.environmentId ?? "";
    // The id names everything the code and bindings depend on, so a cached isolate never serves
    // another workspace or a changed injector.
    const id = `injector-${injector.sha256}-${workspaceId}-${environmentId}-${injector.name}`;

    const worker = this.env.LOADER.get(id, () => ({
      compatibilityDate: INJECTOR_COMPATIBILITY_DATE,
      mainModule: "injector.js",
      modules: { "injector.js": injector.code },
      globalOutbound: this.ctx.exports.TempoOutbound({
        props: { workspaceId, userId, injector: injector.name },
      }),
      env: { SECRETS: this.ctx.exports.InjectorSecrets({ props: { userId, environmentId } }) },
    }));

    try {
      return await worker.getEntrypoint().fetch(request);
    } catch {
      return block(502, `tempo: injector ${injector.name} failed`);
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
    kind:
      | "github-basic"
      | "github-bearer"
      | "artifact-bearer"
      | "dotfiles-bearer"
      | "deploy-bearer"
      | "openrouter"
      | "anthropic"
      | "openai",
    userId: string,
  ): Promise<string | null> {
    if (kind === "deploy-bearer") {
      const token = await this.env.WORKSPACE.getByName(this.ctx.props.workspaceId).getDeployToken();

      return token === null ? null : `Bearer ${token}`;
    }

    if (kind === "dotfiles-bearer") {
      const token = await this.env.WORKSPACE.getByName(this.ctx.props.workspaceId).getDotfilesToken();

      return token === null ? null : `Bearer ${token}`;
    }

    if (kind === "artifact-bearer") {
      const token = await this.env.WORKSPACE.getByName(this.ctx.props.workspaceId).getRepositoryToken();

      return token === null ? null : `Bearer ${token}`;
    }

    if (kind === "github-basic" || kind === "github-bearer") {
      const token = await this.env.WORKSPACE.getByName(this.ctx.props.workspaceId).getGithubToken();

      if (!token) return null;

      return kind === "github-basic" ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`;
    }

    const creds = this.env.CREDENTIALS.getByName(userId);
    const key = await creds.getSecret(SECRET_KEYS[kind]);

    if (key === null) return null;

    return kind === "anthropic" ? key : `Bearer ${key}`;
  }
}

export interface InjectorSecretsProps {
  readonly userId: string;
  readonly environmentId: string;
}

const HASHES = new Set(["SHA-1", "SHA-256", "SHA-512"]);

/** `env.SECRETS` inside an injector (01, rule 13): MACs, never raw values. */
export class InjectorSecrets extends WorkerEntrypoint<Env, InjectorSecretsProps> {
  async hmac(
    name: string,
    data: string | ArrayBuffer,
    options: { hash: "SHA-1" | "SHA-256" | "SHA-512"; prefix?: string },
  ): Promise<ArrayBuffer> {
    if (!HASHES.has(options?.hash)) throw new Error("hash must be SHA-1, SHA-256 or SHA-512");
    const { userId, environmentId } = this.ctx.props;

    const mac = await this.env.CREDENTIALS.getByName(userId).hmacEnvironmentSecret(
      environmentId,
      name,
      data,
      options.hash,
      options.prefix ?? "",
    );

    if (mac === null) throw new Error(`secret ${name} is not set`);

    return mac;
  }
}
