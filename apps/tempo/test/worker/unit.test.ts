import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OP_KINDS,
  PLACEHOLDER,
  REDACTED,
  TempoError,
  WORKSPACE_STATES,
  newId,
  newPreviewToken,
  reconnectDelay,
  redact,
  type WorkspaceState,
} from "@tempo/protocol";
import { AGENT_HOSTS, decide, hostMatches, isRepoPath, type EgressConfig } from "../../src/egress/rules.ts";
import { IllegalTransition, assertTransition, canTransition } from "../../src/do/workspace/transitions.ts";
import { checksStateOf, prStateOf } from "../../src/github/provider.ts";
import { appJwt, pkcs1ToPkcs8 } from "../../src/github/app.ts";
import {
  base64ToBytes,
  bytesToBase64,
  deriveKey,
  open,
  seal,
  sha256Hex,
  timingSafeEqual,
} from "../../src/lib/crypto.ts";
import { isValidBranch } from "../../src/do/workspace/rpc.ts";
import { parseCodexAuth } from "../../src/server/handlers/credentials.ts";
import { OP_STEPS, backoffMs, limitOf } from "../../src/do/workspace/runner.ts";
import { handlePreview, isPreviewHost, parsePreviewHost } from "../../src/http/preview.ts";
import { sanitizeName } from "../../src/http/attachments.ts";

import { HOME_EXCLUDES } from "../../src/do/workspace/durability.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// egress/rules.ts — 01 "Credentials and egress" (TempoOutbound rules table) and 05 "Egress control"
// ---------------------------------------------------------------------------------------------

describe("egress decide()", () => {
  const APP = "tempo.test";
  const open_: EgressConfig = { owner: "acme", repo: "app", policy: "open", allowlist: [], mcp: [] };
  const allow: EgressConfig = {
    owner: "acme",
    repo: "app",
    policy: "allowlist",
    allowlist: ["pypi.org", "*.example.com"],
    mcp: [],
  };
  const d = (url: string, headers: Record<string, string> = {}, config: EgressConfig = open_) =>
    decide(new URL(url), new Headers(headers), APP, config);

  describe("rule 0: APP_HOST", () => {
    // 05 Egress control: "Rule 0 ... a request whose host is APP_HOST returns 403."
    it("blocks https to APP_HOST with 403 under open policy", () => {
      const r = d("https://tempo.test/api/server/listProjects");
      expect(r).toMatchObject({ rule: 0, action: "block", status: 403 });
    });
    it("blocks APP_HOST case-insensitively", () => {
      expect(d("https://TEMPO.Test/")).toMatchObject({ rule: 0, action: "block", status: 403 });
    });
    it("runs before rule 1: http: to APP_HOST is still blocked by rule 0", () => {
      expect(d("http://tempo.test/")).toMatchObject({ rule: 0, action: "block", status: 403 });
    });
    it("runs before every other rule, even for an allowlisted pattern", () => {
      const cfg: EgressConfig = { ...allow, allowlist: ["tempo.test"] };
      expect(d("https://tempo.test/", {}, cfg)).toMatchObject({ rule: 0, action: "block", status: 403 });
    });
    it("does not block a subdomain of APP_HOST by rule 0", () => {
      expect(d("https://x.tempo.test/")).toMatchObject({ rule: 8, action: "forward" });
    });
  });

  describe("rule 1: http: scheme", () => {
    // 01: "Scheme http: | Skip rules 2 to 7 and apply rules 8 to 10. MUST NOT add credentials."
    it("adds no GitHub credentials to an http: repo path", () => {
      const r = d("http://github.com/acme/app.git/info/refs");
      expect(r.action).toBe("forward");
      expect("set" in r ? r.set : undefined).toBeUndefined();
      expect(r.rule).toBe(8);
    });
    it("adds no bearer token to http: api.github.com", () => {
      const r = d("http://api.github.com/repos/acme/app");
      expect(r).toEqual({ rule: 8, action: "forward" });
    });
    it("does not swap placeholder keys over http:", () => {
      const r = d("http://api.anthropic.com/v1/messages", { "x-api-key": PLACEHOLDER });
      expect(r.action).toBe("forward");
      expect("set" in r ? r.set : undefined).toBeUndefined();
    });
    it("applies the allowlist (rule 9) to http: requests", () => {
      expect(d("http://pypi.org/simple/", {}, allow)).toEqual({ rule: 9, action: "forward" });
    });
    it("applies rule 10 to http: hosts outside the allowlist", () => {
      expect(d("http://evil.test/", {}, allow)).toEqual({
        rule: 10,
        action: "block",
        status: 403,
        body: "tempo: egress blocked for evil.test",
      });
    });
  });

  describe("rule 2: GitHub git over HTTPS for this repo", () => {
    // 01: "Host github.com or codeload.github.com, path starts with /<owner>/<repo> of this project
    // (case-insensitive, optional .git) | Set Authorization: Basic ..."
    const rule2 = { rule: 2, action: "forward", set: { name: "authorization", value: "github-basic" } };
    it.each([
      "https://github.com/acme/app.git/info/refs?service=git-upload-pack",
      "https://github.com/acme/app/info/refs?service=git-receive-pack",
      "https://github.com/acme/app.git",
      "https://github.com/acme/app",
      "https://github.com/ACME/App.GIT/git-upload-pack",
      "https://github.com/Acme/APP/archive/refs/heads/main.zip",
      "https://codeload.github.com/acme/app/tar.gz/refs/heads/main",
      "https://codeload.github.com/acme/app.git/zip/main",
    ])("adds Basic credentials for %s", (url) => {
      expect(d(url)).toEqual(rule2);
    });
    it.each([
      "https://github.com/acme/other.git/info/refs",
      "https://github.com/other/app.git/info/refs",
      "https://github.com/acme",
      "https://github.com/login",
      "https://github.com/acme/app2.git/info/refs",
      "https://gist.github.com/acme/app",
      "https://raw.githubusercontent.com/acme/app/main/README.md",
    ])("adds no credentials for another repo or host: %s", (url) => {
      expect(d(url)).toEqual({ rule: 8, action: "forward" });
    });
    it("matches the repo path under the allowlist policy too", () => {
      expect(d("https://github.com/acme/app.git/info/refs", {}, allow)).toEqual(rule2);
    });
  });

  describe("rule 3: GitHub API", () => {
    // 01: "Host api.github.com or uploads.github.com | Set Authorization: Bearer <token>"
    const rule3 = { rule: 3, action: "forward", set: { name: "authorization", value: "github-bearer" } };
    it("adds the bearer token for api.github.com", () => {
      expect(d("https://api.github.com/repos/acme/app/pulls")).toEqual(rule3);
    });
    it("adds the bearer token for uploads.github.com", () => {
      expect(d("https://uploads.github.com/repos/acme/app/releases/1/assets")).toEqual(rule3);
    });
    it("wins over rule 7 even when the container sent the placeholder", () => {
      expect(d("https://api.github.com/user", { authorization: `Bearer ${PLACEHOLDER}` })).toEqual(rule3);
    });
    it("does not match a look-alike host", () => {
      expect(d("https://api.github.com.evil.test/")).toEqual({ rule: 8, action: "forward" });
    });
  });

  describe("rules 4 to 6: placeholder key swaps", () => {
    // 01: rule 4 "Host openrouter.ai, header Authorization: Bearer tempo-placeholder"
    it("rule 4 swaps the OpenRouter key", () => {
      expect(
        d("https://openrouter.ai/api/v1/chat/completions", { Authorization: "Bearer tempo-placeholder" }),
      ).toEqual({
        rule: 4,
        action: "forward",
        set: { name: "authorization", value: "openrouter" },
      });
    });
    // 01: rule 5 "Host api.anthropic.com, header x-api-key: tempo-placeholder"
    it("rule 5 swaps the Anthropic key", () => {
      expect(d("https://api.anthropic.com/v1/messages", { "X-Api-Key": "tempo-placeholder" })).toEqual({
        rule: 5,
        action: "forward",
        set: { name: "x-api-key", value: "anthropic" },
      });
    });
    // 01: rule 6 "Host api.openai.com, header Authorization: Bearer tempo-placeholder"
    it("rule 6 swaps the OpenAI key", () => {
      expect(d("https://api.openai.com/v1/responses", { authorization: "Bearer tempo-placeholder" })).toEqual(
        {
          rule: 6,
          action: "forward",
          set: { name: "authorization", value: "openai" },
        },
      );
    });
    it("passes a real key to openrouter.ai unchanged (rule 8)", () => {
      expect(d("https://openrouter.ai/api/v1/models", { authorization: "Bearer sk-or-real" })).toEqual({
        rule: 8,
        action: "forward",
      });
    });
    it("does not apply rule 5's swap to the Authorization header on api.anthropic.com (falls to rule 7)", () => {
      expect(
        d("https://api.anthropic.com/v1/messages", { authorization: `Bearer ${PLACEHOLDER}` }),
      ).toMatchObject({
        rule: 7,
        action: "block",
        status: 403,
      });
    });
    it("does not apply rule 6's header to openrouter.ai keyed by x-api-key (falls to rule 7)", () => {
      expect(d("https://openrouter.ai/api/v1/chat", { "x-api-key": PLACEHOLDER })).toMatchObject({
        rule: 7,
        status: 403,
      });
    });
    it("does not swap the OpenAI key for a different host", () => {
      expect(
        d("https://api.openai.com.evil.test/v1", { authorization: `Bearer ${PLACEHOLDER}` }),
      ).toMatchObject({
        rule: 7,
        action: "block",
      });
    });
  });

  describe("rule 11: MCP secret headers", () => {
    // 01: swap only the server's own placeholder, only for the server's own host.
    const sid = "01jmcpserver0000000000000a";
    const mcp = [{ serverId: sid, host: "mcp.linear.app", secretHeaders: ["authorization"] }];
    const withMcp: EgressConfig = { ...allow, mcp };
    const ph = `tempo-placeholder:mcp:${sid}:authorization`;
    it("swaps the placeholder for the server host", () => {
      expect(d("https://mcp.linear.app/mcp", { Authorization: ph }, withMcp)).toEqual({
        rule: 11,
        action: "forward",
        mcp: [{ name: "authorization", key: `mcp.${sid}.header.authorization` }],
      });
    });
    it("refuses the placeholder sent to another host", () => {
      const r = d("https://evil.example.com/", { Authorization: ph }, { ...withMcp, policy: "open" });
      expect(r).toMatchObject({ rule: 7, action: "block", status: 403 });
    });
    it("refuses another server's placeholder on this host", () => {
      const other = `tempo-placeholder:mcp:01jother00000000000000000a:authorization`;
      expect(d("https://mcp.linear.app/mcp", { Authorization: other }, withMcp)).toMatchObject({ rule: 7 });
    });
    it("refuses the placeholder in a header that is not secret", () => {
      expect(d("https://mcp.linear.app/mcp", { "X-Key": ph }, withMcp)).toMatchObject({ rule: 7 });
    });
    it("never swaps over http:", () => {
      expect(d("http://mcp.linear.app/mcp", { Authorization: ph }, withMcp)).toEqual({
        rule: 9,
        action: "forward",
      });
    });
    it("allows MCP hosts under the allowlist policy (rule 9)", () => {
      expect(d("https://mcp.linear.app/mcp", {}, withMcp)).toMatchObject({ rule: 9, action: "forward" });
      expect(d("https://mcp.linear.app/mcp", {}, allow)).toMatchObject({ rule: 10, action: "block" });
    });
  });

  describe("rule 7: placeholder anywhere else", () => {
    // 01: "Any request that still carries tempo-placeholder | Return 403. MUST NOT forward the placeholder."
    it.each([
      ["x-custom", PLACEHOLDER],
      ["cookie", `session=${PLACEHOLDER}`],
      ["authorization", `Basic ${PLACEHOLDER}`],
      ["authorization", `bearer ${PLACEHOLDER}`],
      ["x-api-key", `prefix-${PLACEHOLDER}-suffix`],
    ])("blocks header %s: %s", (name, value) => {
      const r = d("https://example.org/upload", { [name]: value });
      expect(r).toEqual({
        rule: 7,
        action: "block",
        status: 403,
        body: "tempo: placeholder credential refused",
      });
    });
    it("blocks the placeholder in an unrelated header on a key-swap host", () => {
      expect(d("https://api.openai.com/v1/models", { "x-other": PLACEHOLDER })).toMatchObject({
        rule: 7,
        status: 403,
      });
    });
    it("blocks the placeholder before the allowlist check", () => {
      expect(d("https://pypi.org/simple/", { "x-token": PLACEHOLDER }, allow)).toMatchObject({
        rule: 7,
        status: 403,
      });
    });
    it("blocks the placeholder carried in the URL", () => {
      expect(d(`https://example.org/?key=${PLACEHOLDER}`)).toMatchObject({ rule: 7, status: 403 });
    });
    it("does not block when no header carries the placeholder", () => {
      expect(d("https://example.org/", { "x-custom": "tempo-placeholde" })).toEqual({
        rule: 8,
        action: "forward",
      });
    });
  });

  describe("rules 8 to 10: policy", () => {
    // 01: "8 | Egress policy open | Pass through unchanged"
    it("rule 8 passes any host through under policy open", () => {
      expect(d("https://pypi.org/simple/")).toEqual({ rule: 8, action: "forward" });
      expect(d("https://anything.invalid/x")).toEqual({ rule: 8, action: "forward" });
    });
    // 01: built-in agent hosts for allowlist
    it.each([...AGENT_HOSTS])("rule 9 passes built-in agent host %s", (host) => {
      expect(d(`https://${host}/x`, {}, { ...allow, allowlist: [] })).toMatchObject({ action: "forward" });
    });
    it("lists exactly the built-in agent hosts of 01", () => {
      expect([...AGENT_HOSTS].sort()).toEqual(
        [
          "api.anthropic.com",
          "claude.ai",
          "console.anthropic.com",
          "chatgpt.com",
          "auth.openai.com",
          "api.openai.com",
          "openrouter.ai",
          "registry.npmjs.org",
          "github.com",
          "api.github.com",
          "codeload.github.com",
          "objects.githubusercontent.com",
          "cdn.playwright.dev",
          "storage.googleapis.com",
        ].sort(),
      );
    });
    it("rule 9 forwards non-credential agent hosts as rule 9 with no credentials", () => {
      expect(d("https://registry.npmjs.org/react", {}, allow)).toEqual({ rule: 9, action: "forward" });
      expect(d("https://claude.ai/api", {}, allow)).toEqual({ rule: 9, action: "forward" });
    });
    it("rule 9 passes an exact project pattern", () => {
      expect(d("https://pypi.org/simple/", {}, allow)).toEqual({ rule: 9, action: "forward" });
    });
    // 05: "*.example.com matches a.example.com but not example.com"
    it("rule 9 passes a.example.com for *.example.com", () => {
      expect(d("https://a.example.com/", {}, allow)).toEqual({ rule: 9, action: "forward" });
    });
    it("rule 10 blocks example.com for *.example.com", () => {
      expect(d("https://example.com/", {}, allow)).toEqual({
        rule: 10,
        action: "block",
        status: 403,
        body: "tempo: egress blocked for example.com",
      });
    });
    // 01: "10 | Anything else | Return 403, body tempo: egress blocked for <host>"
    it("rule 10 blocks hosts outside the allowlist with the exact body", () => {
      expect(d("https://files.pythonhosted.org/x", {}, allow)).toEqual({
        rule: 10,
        action: "block",
        status: 403,
        body: "tempo: egress blocked for files.pythonhosted.org",
      });
    });
    it("rule 10 blocks look-alikes of agent hosts", () => {
      expect(d("https://api.anthropic.com.evil.test/", {}, allow)).toMatchObject({ rule: 10, status: 403 });
      expect(d("https://evilclaude.ai/", {}, allow)).toMatchObject({ rule: 10, status: 403 });
      expect(d("https://pypi.org.evil.test/", {}, allow)).toMatchObject({ rule: 10, status: 403 });
    });
  });
});

describe("hostMatches", () => {
  // 05 Egress control: "A pattern is a host or *. plus a domain; *.example.com matches a.example.com but not example.com."
  it("matches a subdomain for a wildcard pattern", () => {
    expect(hostMatches("a.example.com", "*.example.com")).toBe(true);
  });
  it("does not match the apex for a wildcard pattern", () => {
    expect(hostMatches("example.com", "*.example.com")).toBe(false);
  });
  it("does not match a host that only shares a suffix", () => {
    expect(hostMatches("aexample.com", "*.example.com")).toBe(false);
    expect(hostMatches("a.example.com.evil", "*.example.com")).toBe(false);
  });
  it("matches an exact pattern only exactly", () => {
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("a.example.com", "example.com")).toBe(false);
    expect(hostMatches("example.co", "example.com")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(hostMatches("A.Example.COM", "*.example.com")).toBe(true);
    expect(hostMatches("pypi.org", "PyPI.org")).toBe(true);
  });
});

describe("isRepoPath", () => {
  // 01 rule 2: "path starts with /<owner>/<repo> of this project (case-insensitive, optional .git)"
  it.each([
    "/acme/app",
    "/acme/app.git",
    "/acme/app/",
    "/acme/app/info/refs",
    "/acme/app.git/info/refs",
    "/ACME/APP",
    "/Acme/App.Git/x",
  ])("accepts %s", (p) => {
    expect(isRepoPath(p, "acme", "app")).toBe(true);
  });
  it.each([
    "/acme",
    "/acme/",
    "/acme/apps",
    "/acme/app2/info/refs",
    "/acme/app.gitx",
    "/other/app",
    "/x/acme/app",
    "acme/app",
    "",
  ])("rejects %s", (p) => {
    expect(isRepoPath(p, "acme", "app")).toBe(false);
  });
  it("compares owner and repo given in mixed case", () => {
    expect(isRepoPath("/acme/app.git", "Acme", "App")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// do/workspace/transitions.ts — 03 "Transitions"
// ---------------------------------------------------------------------------------------------

describe("canTransition", () => {
  // 03 Transitions table, row by row ("Only these transitions are allowed").
  const ROWS: ReadonlyArray<readonly [WorkspaceState, WorkspaceState]> = [
    ["creating", "starting"],
    ["starting", "ready"],
    ["starting", "setting_up"],
    ["setting_up", "ready"],
    ["ready", "working"],
    ["working", "ready"],
    ["working", "working"],
    ["ready", "stopping"],
    ["stopping", "sleeping"],
    ["sleeping", "starting"],
    ["ready", "archiving"],
    ["working", "archiving"],
    ["sleeping", "archiving"],
    ["error", "archiving"],
    ["archiving", "archived"],
    ["archived", "sleeping"],
    ["error", "starting"],
    ["ready", "starting"],
    ["working", "starting"],
    ["setting_up", "starting"],
  ];
  // "Any state except archived | A step fails for good | error"
  const TO_ERROR: ReadonlyArray<WorkspaceState> = WORKSPACE_STATES.filter(
    (s) => s !== "archived" && s !== "error",
  );

  it.each(ROWS)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });
  it.each(TO_ERROR.map((s) => [s] as const))("allows %s -> error", (from) => {
    expect(canTransition(from, "error")).toBe(true);
  });
  it("disallows archived -> error", () => {
    expect(canTransition("archived", "error")).toBe(false);
  });
  it.each([
    ["creating", "ready"],
    ["creating", "setting_up"],
    ["creating", "archiving"],
    ["starting", "working"],
    ["starting", "archiving"],
    ["setting_up", "working"],
    ["setting_up", "archiving"],
    ["ready", "sleeping"],
    ["working", "stopping"],
    ["stopping", "ready"],
    ["stopping", "starting"],
    ["stopping", "archiving"],
    ["sleeping", "ready"],
    ["sleeping", "stopping"],
    ["archiving", "sleeping"],
    ["archiving", "ready"],
    ["archived", "starting"],
    ["archived", "ready"],
    ["archived", "archiving"],
    ["error", "ready"],
    ["error", "sleeping"],
  ] as const)("disallows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
  it("matches the 03 table for every ordered pair of distinct states", () => {
    const allowed = new Set(
      [...ROWS, ...TO_ERROR.map((s) => [s, "error"] as const)].map(([f, t]) => `${f}->${t}`),
    );
    const mismatches: string[] = [];
    for (const from of WORKSPACE_STATES) {
      for (const to of WORKSPACE_STATES) {
        if (from === to) continue;
        const want = allowed.has(`${from}->${to}`);
        if (canTransition(from, to) !== want) mismatches.push(`${from}->${to} want ${want}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
  // 03: "Any other change of workspace.state is a bug and MUST throw."
  it("assertTransition throws IllegalTransition for a disallowed change", () => {
    expect(() => assertTransition("archived", "error")).toThrow(IllegalTransition);
    expect(() => assertTransition("sleeping", "ready")).toThrow(/sleeping/);
  });
  it("assertTransition does not throw for an allowed change", () => {
    expect(() => assertTransition("creating", "starting")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// github/provider.ts — 03 "Status polling"
// ---------------------------------------------------------------------------------------------

describe("prStateOf", () => {
  // 03: "merged if merged, else closed if state = closed, else draft if draft, else open."
  it("is merged when merged, even if closed and draft", () => {
    expect(
      prStateOf({ merged: true, merged_at: "2026-01-01T00:00:00Z", state: "closed", draft: true } as never),
    ).toBe("merged");
  });
  it("is closed when closed and not merged", () => {
    expect(prStateOf({ merged: false, merged_at: null, state: "closed", draft: false } as never)).toBe(
      "closed",
    );
  });
  it("is closed, not draft, when a draft PR is closed", () => {
    expect(prStateOf({ merged: false, merged_at: null, state: "closed", draft: true } as never)).toBe(
      "closed",
    );
  });
  it("is draft when open and draft", () => {
    expect(prStateOf({ merged: false, merged_at: null, state: "open", draft: true } as never)).toBe("draft");
  });
  it("is open otherwise", () => {
    expect(prStateOf({ merged: false, merged_at: null, state: "open", draft: false } as never)).toBe("open");
  });
});

describe("checksStateOf", () => {
  const run = (status: string, conclusion: string | null = null) => ({ status, conclusion });
  // 03: "No check runs at all leaves checks_state = null."
  it("is null with no check runs", () => {
    expect(checksStateOf([])).toBeNull();
  });
  // 03: "pending if any run is queued or in_progress"
  it("is pending when any run is queued", () => {
    expect(checksStateOf([run("completed", "success"), run("queued")])).toBe("pending");
  });
  it("is pending when any run is in_progress, even with a failure", () => {
    expect(checksStateOf([run("completed", "failure"), run("in_progress")])).toBe("pending");
  });
  // 03: "else failure if any conclusion is failure, cancelled, timed_out or action_required"
  it.each(["failure", "cancelled", "timed_out", "action_required"])(
    "is failure when a conclusion is %s",
    (c) => {
      expect(checksStateOf([run("completed", "success"), run("completed", c)])).toBe("failure");
    },
  );
  // 03: "else success"
  it.each(["success", "neutral", "skipped", "stale"])("is success when every conclusion is %s", (c) => {
    expect(checksStateOf([run("completed", c), run("completed", "success")])).toBe("success");
  });
});

// ---------------------------------------------------------------------------------------------
// github/app.ts — App JWT (RS256) and PKCS#1 → PKCS#8
// ---------------------------------------------------------------------------------------------

/** Reads one DER TLV at `at`: returns the tag, the content start and the content length. */
const derTlv = (b: Uint8Array, at: number) => {
  const tag = b[at]!;
  let len = b[at + 1]!;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[at + 2 + i]!;
    start += n;
  }
  return { tag, start, len, end: start + len };
};

/** PrivateKeyInfo → the inner RSAPrivateKey (PKCS#1) octets. */
const pkcs8ToPkcs1 = (pkcs8: Uint8Array): Uint8Array => {
  const outer = derTlv(pkcs8, 0);
  const version = derTlv(pkcs8, outer.start);
  const alg = derTlv(pkcs8, version.end);
  const octet = derTlv(pkcs8, alg.end);
  expect(octet.tag).toBe(0x04);
  return pkcs8.slice(octet.start, octet.end);
};

const pem = (label: string, der: Uint8Array) => {
  const b64 = bytesToBase64(der);
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
};

const b64urlDecode = (s: string): Uint8Array =>
  base64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

const rsaKeys = (async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return { pair, pkcs8, pkcs1: pkcs8ToPkcs1(pkcs8) };
})();

const verifyJwt = async (jwt: string, publicKey: CryptoKey) => {
  const [h, p, s] = jwt.split(".");
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    b64urlDecode(s!) as never,
    new TextEncoder().encode(`${h}.${p}`),
  );
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h!)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p!)));
  return { ok, header, payload, parts: [h!, p!, s!] };
};

describe("pkcs1ToPkcs8", () => {
  it("wraps an RSAPrivateKey into the same PrivateKeyInfo WebCrypto exports", async () => {
    const { pkcs8, pkcs1 } = await rsaKeys;
    expect(pkcs1[0]).toBe(0x30);
    expect([...pkcs1ToPkcs8(pkcs1)]).toEqual([...pkcs8]);
  });
  it("produces bytes WebCrypto imports as a signing key", async () => {
    const { pkcs1 } = await rsaKeys;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs1ToPkcs8(pkcs1),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    expect(key.type).toBe("private");
  });
  it("encodes short and long DER lengths", () => {
    const short = pkcs1ToPkcs8(new Uint8Array(5));
    expect(short[0]).toBe(0x30);
    expect(short[1]).toBe(short.length - 2);
    const long = pkcs1ToPkcs8(new Uint8Array(300));
    expect(long[1]).toBe(0x82);
    expect((long[2]! << 8) | long[3]!).toBe(long.length - 4);
  });
  it("yields a key WebCrypto refuses when the input is not an RSAPrivateKey", async () => {
    await expect(
      crypto.subtle.importKey(
        "pkcs8",
        pkcs1ToPkcs8(new Uint8Array([1, 2, 3])),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    ).rejects.toThrow();
  });
});

describe("appJwt", () => {
  const config = (privateKey: string) => ({
    appId: "123456",
    slug: "tempo-test",
    privateKey,
    clientId: "Iv1.x",
    clientSecret: "s",
  });

  it("signs an RS256 JWT with a PKCS#1 key (GitHub's format) and sets iss, iat, exp", async () => {
    const { pair, pkcs1 } = await rsaKeys;
    const now = Date.UTC(2026, 9, 11, 12, 0, 0, 500);
    const jwt = await appJwt(config(pem("RSA PRIVATE KEY", pkcs1)), now);
    const { ok, header, payload, parts } = await verifyJwt(jwt, pair.publicKey);
    expect(ok).toBe(true);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("123456");
    const nowS = Math.floor(now / 1000);
    expect(payload.iat).toBe(nowS - 60);
    expect(payload.exp).toBeGreaterThan(nowS);
    // GitHub rejects an App JWT that expires more than 10 minutes in the future.
    expect(payload.exp - nowS).toBeLessThanOrEqual(600);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    for (const part of parts) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("signs with a PKCS#8 PEM key as well", async () => {
    const { pair, pkcs8 } = await rsaKeys;
    const jwt = await appJwt(config(pem("PRIVATE KEY", pkcs8)));
    const { ok, payload } = await verifyJwt(jwt, pair.publicKey);
    expect(ok).toBe(true);
    const nowS = Math.floor(Date.now() / 1000);
    expect(payload.iat).toBeLessThanOrEqual(nowS);
    expect(payload.exp).toBeGreaterThan(nowS);
  });

  it("does not verify against a different public key", async () => {
    const { pkcs8 } = await rsaKeys;
    const other = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwt = await appJwt(config(pem("PRIVATE KEY", pkcs8)));
    expect((await verifyJwt(jwt, other.publicKey)).ok).toBe(false);
  });

  it("rejects a malformed private key", async () => {
    await expect(
      appJwt(config("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n")),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// lib/crypto.ts — 02 "Encryption"
// ---------------------------------------------------------------------------------------------

describe("crypto", () => {
  const master = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

  it("round-trips a secret with seal and open", async () => {
    const key = await deriveKey(master, "user-1");
    const sealed = await seal(key, "openrouter.api_key", "sk-or-secret");
    expect(await open(key, "openrouter.api_key", sealed)).toBe("sk-or-secret");
  });

  it("round-trips the empty string and unicode", async () => {
    const key = await deriveKey(master, "user-1");
    expect(await open(key, "k", await seal(key, "k", ""))).toBe("");
    expect(await open(key, "k", await seal(key, "k", "pässwörd ✓ 鍵"))).toBe("pässwörd ✓ 鍵");
  });

  // 02: "Use the secret's key name as additional authenticated data, so a ciphertext cannot be moved to another key."
  it("fails to open under a different key name (AAD)", async () => {
    const key = await deriveKey(master, "user-1");
    const sealed = await seal(key, "anthropic.api_key", "sk-ant");
    await expect(open(key, "openai.api_key", sealed)).rejects.toThrow();
  });

  // 02: "salt = the user id"
  it("fails to open with a key derived from a different salt", async () => {
    const sealed = await seal(await deriveKey(master, "user-1"), "k", "v");
    await expect(open(await deriveKey(master, "user-2"), "k", sealed)).rejects.toThrow();
    await expect(open(await deriveKey(master, "system"), "k", sealed)).rejects.toThrow();
  });

  it("fails to open with a different master key", async () => {
    const sealed = await seal(await deriveKey(master, "user-1"), "k", "v");
    const other = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    await expect(open(await deriveKey(other, "user-1"), "k", sealed)).rejects.toThrow();
  });

  it("fails to open a tampered ciphertext", async () => {
    const key = await deriveKey(master, "user-1");
    const sealed = await seal(key, "k", "value");
    const ct = new Uint8Array(sealed.ciphertext.slice(0));
    ct[0] = ct[0]! ^ 1;
    await expect(open(key, "k", { ciphertext: ct.buffer, iv: sealed.iv })).rejects.toThrow();
  });

  it("uses a fresh random 12-byte IV for every seal", async () => {
    const key = await deriveKey(master, "user-1");
    const a = await seal(key, "k", "same");
    const b = await seal(key, "k", "same");
    expect(a.iv.byteLength).toBe(12);
    expect(b.iv.byteLength).toBe(12);
    expect(bytesToBase64(new Uint8Array(a.iv))).not.toBe(bytesToBase64(new Uint8Array(b.iv)));
    expect(bytesToBase64(new Uint8Array(a.ciphertext))).not.toBe(bytesToBase64(new Uint8Array(b.ciphertext)));
  });

  it("does not leave the plaintext in the ciphertext", async () => {
    const key = await deriveKey(master, "user-1");
    const sealed = await seal(key, "k", "plain-secret-value");
    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain("plain-secret-value");
    // AES-GCM: ciphertext = plaintext length + 16-byte tag.
    expect(sealed.ciphertext.byteLength).toBe("plain-secret-value".length + 16);
  });

  // 02: "Derive the AES-256-GCM key with HKDF-SHA256: salt = the user id, info = tempo-secrets-v1."
  it("derives exactly HKDF-SHA256(master, salt = user id, info = tempo-secrets-v1)", async () => {
    const enc = new TextEncoder();
    const ikm = await crypto.subtle.importKey("raw", base64ToBytes(master), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("user-9"), info: enc.encode("tempo-secrets-v1") },
      ikm,
      256,
    );
    const reference = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode("x.key") },
      reference,
      enc.encode("hello"),
    );
    expect(await open(await deriveKey(master, "user-9"), "x.key", { ciphertext, iv: iv.buffer })).toBe(
      "hello",
    );
  });

  // 05: "TEMPO_ENCRYPTION_KEY | Worker secret | Deploy (32 random bytes, base64)"
  it("rejects a master key that is not 32 bytes", async () => {
    await expect(deriveKey(bytesToBase64(new Uint8Array(16)), "user-1")).rejects.toThrow(/32 bytes/);
    await expect(deriveKey(bytesToBase64(new Uint8Array(33)), "user-1")).rejects.toThrow(/32 bytes/);
  });

  it("accepts the deployment's TEMPO_ENCRYPTION_KEY binding", async () => {
    const key = await deriveKey(env.TEMPO_ENCRYPTION_KEY, "system");
    expect(await open(key, "github_app.private_key", await seal(key, "github_app.private_key", "pem"))).toBe(
      "pem",
    );
  });
});

describe("timingSafeEqual", () => {
  it("is true for equal strings", () => {
    expect(timingSafeEqual("abcdefghijklmnop", "abcdefghijklmnop")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("ü✓", "ü✓")).toBe(true);
  });
  it("is false for a single differing character", () => {
    expect(timingSafeEqual("abcdefghijklmnop", "abcdefghijklmnoq")).toBe(false);
    expect(timingSafeEqual("bbcdefghijklmnop", "abcdefghijklmnop")).toBe(false);
  });
  it("is false for different lengths, including a prefix", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    expect(timingSafeEqual("", "a")).toBe(false);
  });
  it("is false when a shorter string padded with NUL would otherwise compare equal", () => {
    expect(timingSafeEqual("abc", "abc\0")).toBe(false);
  });
  it("is case-sensitive", () => {
    expect(timingSafeEqual("Token", "token")).toBe(false);
  });
});

describe("base64 helpers", () => {
  it("encodes and decodes known vectors", () => {
    expect(bytesToBase64(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy");
    expect(bytesToBase64(new TextEncoder().encode("fo"))).toBe("Zm8=");
    expect(new TextDecoder().decode(base64ToBytes("Zm9vYg=="))).toBe("foob");
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toHaveLength(0);
  });
  it("round-trips every byte value", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect([...base64ToBytes(bytesToBase64(all))]).toEqual([...all]);
  });
  it("trims surrounding whitespace before decoding", () => {
    expect([...base64ToBytes("  AQID\n")]).toEqual([1, 2, 3]);
  });
  it("throws on input that is not base64", () => {
    expect(() => base64ToBytes("not base64!")).toThrow();
  });
  it("decodes the 32-byte test TEMPO_ENCRYPTION_KEY", () => {
    expect(base64ToBytes("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")).toHaveLength(32);
  });
  it("sha256Hex matches the FIPS 180-2 vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

// ---------------------------------------------------------------------------------------------
// do/workspace/rpc.ts isValidBranch — 02 errors: "BRANCH_INVALID | Not a valid git branch name"
// ---------------------------------------------------------------------------------------------

describe("isValidBranch", () => {
  it.each([
    "main",
    "feature/login",
    "tempo/add-readme",
    "fix-123",
    "a@b",
    "release/v1.2.3",
    "ü-branch",
    "foo/bar.lock.x",
    "UPPER/case",
  ])("accepts %s", (b) => {
    expect(isValidBranch(b)).toBe(true);
  });
  // git check-ref-format rules.
  it.each([
    ["empty", ""],
    ["double dot", "a..b"],
    ["space", "a b"],
    ["tab", "a\tb"],
    ["control char", "a\u0001b"],
    ["DEL", "a\u007fb"],
    ["tilde", "a~1"],
    ["caret", "a^b"],
    ["colon", "a:b"],
    ["question mark", "a?b"],
    ["asterisk", "a*b"],
    ["open bracket", "a[b"],
    ["backslash", "a\\b"],
    ["leading slash", "/a"],
    ["trailing slash", "a/"],
    ["double slash", "a//b"],
    ["trailing dot", "a."],
    ["trailing .lock", "a.lock"],
    ["component starting with dot", "a/.b"],
    ["@{ sequence", "a@{b"],
    ["single @", "@"],
    ["too long", "a".repeat(251)],
  ])("rejects %s", (_label, b) => {
    expect(isValidBranch(b)).toBe(false);
  });
  it("accepts a 250-character name", () => {
    expect(isValidBranch("a".repeat(250))).toBe(true);
  });
  // Regression (fixed): git check-ref-format --branch rejects these, but isValidBranch accepts them (see report).
  it.each([
    ["first component starting with a dot", ".hidden"],
    ["component ending in .lock", "foo.lock/bar"],
    ["leading dash", "-foo"],
    ["HEAD", "HEAD"],
  ])("rejects %s", (_label, b) => {
    expect(isValidBranch(b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// server/handlers/credentials.ts parseCodexAuth — 02 setCodexAuth
// ---------------------------------------------------------------------------------------------

describe("parseCodexAuth", () => {
  // 02: "setCodexAuth | {authJson}: MUST parse and contain tokens.access_token, tokens.refresh_token, last_refresh | {} | VALIDATION_FAILED"
  const valid = {
    OPENAI_API_KEY: null,
    tokens: { id_token: "id", access_token: "at-SECRET", refresh_token: "rt-SECRET", account_id: "acc" },
    last_refresh: "2026-10-01T10:20:30.123456Z",
  };
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return e instanceof TempoError ? e.code : `not a TempoError: ${String(e)}`;
    }
    return undefined;
  };

  it("returns last_refresh as epoch milliseconds (01: Date.parse)", () => {
    expect(parseCodexAuth(JSON.stringify(valid))).toEqual({ lastRefresh: Date.parse(valid.last_refresh) });
  });
  it("rejects text that is not JSON", () => {
    expect(codeOf(() => parseCodexAuth("{not json"))).toBe("VALIDATION_FAILED");
  });
  it.each(["null", "[]", "42", '"str"', "{}"])("rejects the JSON value %s", (s) => {
    expect(codeOf(() => parseCodexAuth(s))).toBe("VALIDATION_FAILED");
  });
  it("rejects a file without tokens.access_token", () => {
    const { access_token: _a, ...tokens } = valid.tokens;
    expect(codeOf(() => parseCodexAuth(JSON.stringify({ ...valid, tokens })))).toBe("VALIDATION_FAILED");
  });
  it("rejects a file without tokens.refresh_token", () => {
    const { refresh_token: _r, ...tokens } = valid.tokens;
    expect(codeOf(() => parseCodexAuth(JSON.stringify({ ...valid, tokens })))).toBe("VALIDATION_FAILED");
  });
  it("rejects a file without last_refresh", () => {
    const { last_refresh: _l, ...rest } = valid;
    expect(codeOf(() => parseCodexAuth(JSON.stringify(rest)))).toBe("VALIDATION_FAILED");
  });
  it("rejects a file without tokens", () => {
    expect(codeOf(() => parseCodexAuth(JSON.stringify({ last_refresh: valid.last_refresh })))).toBe(
      "VALIDATION_FAILED",
    );
    expect(codeOf(() => parseCodexAuth(JSON.stringify({ ...valid, tokens: null })))).toBe(
      "VALIDATION_FAILED",
    );
  });
  it("rejects tokens at the top level instead of under tokens", () => {
    const flat = { access_token: "a", refresh_token: "r", last_refresh: valid.last_refresh };
    expect(codeOf(() => parseCodexAuth(JSON.stringify(flat)))).toBe("VALIDATION_FAILED");
  });
  it("rejects a last_refresh that is not a date", () => {
    expect(codeOf(() => parseCodexAuth(JSON.stringify({ ...valid, last_refresh: "yesterday" })))).toBe(
      "VALIDATION_FAILED",
    );
  });
  // 05 Secrets: "MUST NOT ... put one in an error message"
  it("does not echo token values in the error", () => {
    const bad = JSON.stringify({ ...valid, last_refresh: "nope" });
    try {
      parseCodexAuth(bad);
      expect.unreachable();
    } catch (e) {
      const err = e as TempoError;
      expect(`${err.message} ${err.detail ?? ""}`).not.toContain("SECRET");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// do/workspace/runner.ts — 03 "Step runner"
// ---------------------------------------------------------------------------------------------

describe("backoffMs", () => {
  // 03: "next_run_at = now + min(1 s × 2^(attempt − 1), 60 s) with ±20% jitter"
  const base = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 60_000);

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 20])(
    "attempt %i with no jitter is min(1 s × 2^(attempt − 1), 60 s)",
    (attempt) => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      expect(backoffMs(attempt)).toBe(base(attempt));
    },
  );
  it("gives 1 s, 2 s, 4 s ... and caps at 60 s", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
  });
  it("applies at most -20% jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffMs(1)).toBe(800);
    expect(backoffMs(10)).toBe(48_000);
  });
  it("applies at most +20% jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(backoffMs(1)).toBe(1200);
    expect(backoffMs(10)).toBe(72_000);
  });
  it("stays within ±20% over many samples and actually varies", () => {
    for (const attempt of [1, 3, 7]) {
      const values = new Set<number>();
      for (let i = 0; i < 200; i++) {
        const v = backoffMs(attempt);
        expect(v).toBeGreaterThanOrEqual(base(attempt) * 0.8);
        expect(v).toBeLessThanOrEqual(base(attempt) * 1.2);
        values.add(v);
      }
      expect(values.size).toBeGreaterThan(1);
    }
  });
});

describe("OP_STEPS", () => {
  // 03 "Ops and their steps", in order; `done` is the terminal marker.
  const SPEC: Record<string, string[]> = {
    create: ["container.start", "tempod.connect", "repo.clone", "settings.read", "setup.run"],
    // "if fresh disk: repo.clone → repo.applyCheckpoint → home.restore → settings.read → setup.run; then sessions.markReload"
    wake: [
      "container.start",
      "tempod.connect",
      "repo.clone",
      "repo.applyCheckpoint",
      "home.restore",
      "settings.read",
      "setup.run",
      "sessions.markReload",
    ],
    sleep: [
      "turns.check",
      "git.checkpoint",
      "bundle.upload",
      "home.backup",
      "tempod.shutdown",
      "container.snapshot",
      "container.destroy",
    ],
    archive: [
      "turns.cancel",
      "script.archive",
      "git.checkpoint",
      "bundle.upload",
      "home.backup",
      "tempod.shutdown",
      "container.snapshot",
      "container.destroy",
      "github.deleteBranch",
    ],
    restore: ["branch.check"],
    revert: ["git.checkpoint", "bundle.upload", "git.revert", "transcript.mark"],
    commit_push: ["git.commitAndPush"],
    housekeeping: ["events.prune", "r2.retention", "egress.trim"],
  };

  it("has an entry for every op kind and no others", () => {
    expect(Object.keys(OP_STEPS).sort()).toEqual([...OP_KINDS].sort());
  });
  it.each(Object.keys(SPEC))("lists the steps of %s exactly and in order", (kind) => {
    expect([...OP_STEPS[kind as keyof typeof OP_STEPS]]).toEqual(SPEC[kind]);
  });
  it("never lists done as a step", () => {
    for (const steps of Object.values(OP_STEPS)) expect(steps).not.toContain("done");
  });
});

describe("limitOf (03 Step limits)", () => {
  // 03 "Step limits": max attempts and permanent error codes.
  it.each([
    ["container.start", 3, "CONTAINER_START_FAILED"],
    ["tempod.connect", 5, "TEMPOD_UNREACHABLE"],
    ["repo.clone", 3, "CLONE_FAILED"],
    ["container.destroy", 3, "INTERNAL"],
  ] as const)("%s: %i attempts, then %s", (step, attempts, code) => {
    const l = limitOf(step);
    expect(l.maxAttempts).toBe(attempts);
    expect(l.onPermanent).toMatchObject({ kind: "fail", code });
  });
  it.each([
    ["repo.applyCheckpoint", 2],
    ["home.restore", 2],
    ["settings.read", 3],
    ["setup.run", 1],
    ["script.archive", 1],
    ["git.checkpoint", 3],
    ["bundle.upload", 3],
    ["home.backup", 2],
    ["tempod.shutdown", 1],
    ["container.snapshot", 2],
    ["github.deleteBranch", 3],
  ] as const)("%s: %i attempts, then continues", (step, attempts) => {
    const l = limitOf(step);
    expect(l.maxAttempts).toBe(attempts);
    expect(l.onPermanent.kind).toBe("skip");
  });
  it.each([
    ["tempod.connect", 10_000],
    ["repo.clone", 10 * 60_000],
    ["repo.applyCheckpoint", 5 * 60_000],
    ["settings.read", 10_000],
    ["setup.run", 30 * 60_000],
    ["script.archive", 120_000],
    ["git.checkpoint", 2 * 60_000],
    ["tempod.shutdown", 45_000],
    ["container.destroy", 30_000],
    ["git.revert", 2 * 60_000],
    ["git.commitAndPush", 5 * 60_000],
    ["github.deleteBranch", 30_000],
  ] as const)("%s times out after %i ms", (step, ms) => {
    expect(limitOf(step).timeoutMs).toBe(ms);
  });
  it("uses 30 s, 3 attempts, INTERNAL for any other step", () => {
    const l = limitOf("events.prune");
    expect(l).toMatchObject({
      timeoutMs: 30_000,
      maxAttempts: 3,
      onPermanent: { kind: "fail", code: "INTERNAL" },
    });
  });
  it("git.revert and git.commitAndPush get one attempt and fail", () => {
    expect(limitOf("git.revert")).toMatchObject({
      maxAttempts: 1,
      onPermanent: { kind: "fail", code: "INTERNAL" },
    });
    expect(limitOf("git.commitAndPush")).toMatchObject({ maxAttempts: 1, onPermanent: { kind: "fail" } });
  });
});

// ---------------------------------------------------------------------------------------------
// http/preview.ts — 01 "Preview request path", 05 "Preview access"
// ---------------------------------------------------------------------------------------------

describe("parsePreviewHost", () => {
  // 01: "It matches the first label against ^(\d{4,5})-([0-9a-hjkmnp-tv-z]{26})-([a-z0-9]{16})$. No match returns 404."
  const penv = { PREVIEW_DOMAIN: "previews.test" } as never;
  const ws = newId();
  const token = newPreviewToken();

  it("parses port, workspace id and token", () => {
    expect(parsePreviewHost(`3000-${ws}-${token}.previews.test`, penv)).toEqual({
      port: 3000,
      workspaceId: ws,
      token,
    });
  });
  it("parses a 5-digit port", () => {
    expect(parsePreviewHost(`65535-${ws}-${token}.previews.test`, penv)).toMatchObject({ port: 65535 });
  });
  it("parses a host in upper case (DNS is case-insensitive)", () => {
    expect(parsePreviewHost(`5173-${ws}-${token}.previews.test`.toUpperCase(), penv)).toEqual({
      port: 5173,
      workspaceId: ws,
      token,
    });
  });
  it("uses the real PREVIEW_DOMAIN binding", () => {
    expect(parsePreviewHost(`8080-${ws}-${token}.previews.test`, env as never)).toMatchObject({ port: 8080 });
  });
  it.each([
    ["3-digit port", `808-${ws}-${token}`],
    ["6-digit port", `100000-${ws}-${token}`],
    ["25-char id", `3000-${ws.slice(1)}-${token}`],
    ["27-char id", `3000-${ws}0-${token}`],
    ["id with i", `3000-${ws.slice(0, 25)}i-${token}`],
    ["id with l", `3000-${ws.slice(0, 25)}l-${token}`],
    ["id with o", `3000-${ws.slice(0, 25)}o-${token}`],
    ["id with u", `3000-${ws.slice(0, 25)}u-${token}`],
    ["15-char token", `3000-${ws}-${token.slice(1)}`],
    ["17-char token", `3000-${ws}-${token}a`],
    ["token with _", `3000-${ws}-${token.slice(1)}_`],
    ["missing token", `3000-${ws}`],
    ["non-digit port", `30a0-${ws}-${token}`],
    ["extra part", `3000-${ws}-${token}-x`],
  ])("returns null for %s", (_label, label) => {
    expect(parsePreviewHost(`${label}.previews.test`, penv)).toBeNull();
  });
  it("returns null when the label is not the first label under PREVIEW_DOMAIN", () => {
    expect(parsePreviewHost(`x.3000-${ws}-${token}.previews.test`, penv)).toBeNull();
  });
  it("returns null for the bare preview domain", () => {
    expect(parsePreviewHost("previews.test", penv)).toBeNull();
  });
});

describe("isPreviewHost", () => {
  const penv = { PREVIEW_DOMAIN: "previews.test" } as never;
  it("is true for a subdomain of PREVIEW_DOMAIN", () => {
    expect(isPreviewHost("3000-x-y.previews.test", penv)).toBe(true);
    expect(isPreviewHost("A.PREVIEWS.TEST", penv)).toBe(true);
  });
  it("is false for the apex, look-alikes and other hosts", () => {
    expect(isPreviewHost("previews.test", penv)).toBe(false);
    expect(isPreviewHost("evilpreviews.test", penv)).toBe(false);
    expect(isPreviewHost("a.previews.test.evil.test", penv)).toBe(false);
    expect(isPreviewHost("tempo.test", penv)).toBe(false);
  });
});

describe("handlePreview without a match", () => {
  // 01: "No match returns 404." 05: "A wrong token or an unknown workspace returns 404, never 403."
  it("returns 404 for a label that does not match", async () => {
    const url = new URL("https://not-a-preview.previews.test/");
    const res = await handlePreview(new Request(url), env as never, url);
    expect(res.status).toBe(404);
  });
  it("returns 404 for a port below 1024", async () => {
    const url = new URL(`https://0080-${newId()}-${newPreviewToken()}.previews.test/`);
    const res = await handlePreview(new Request(url), env as never, url);
    expect(res.status).toBe(404);
  });
  it("returns 404 for a port above 65535", async () => {
    const url = new URL(`https://70000-${newId()}-${newPreviewToken()}.previews.test/`);
    const res = await handlePreview(new Request(url), env as never, url);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// http/attachments.ts sanitizeName — the name lands in an R2 key and a container path
// (02 R2 "attachments/<workspaceId>/<attachmentId>/<file name>"; 03 "/home/tempo/attachments/<turnId>/<name>")
// ---------------------------------------------------------------------------------------------

describe("sanitizeName", () => {
  it("keeps an ordinary name", () => {
    expect(sanitizeName("screenshot 2026-10-11.png")).toBe("screenshot 2026-10-11.png");
    expect(sanitizeName("résumé.pdf")).toBe("résumé.pdf");
  });
  it.each(["../../etc/passwd", "a/b.txt", "a\\b.txt", "..\\..\\x", "a\0b"])(
    "removes path separators and NUL from %j",
    (name) => {
      const out = sanitizeName(name);
      expect(out).not.toMatch(/[/\\\0]/);
      expect(out.startsWith(".")).toBe(false);
    },
  );
  it("replaces leading dots so the name cannot be . or .. or hidden", () => {
    expect(sanitizeName(".")).not.toBe(".");
    expect(sanitizeName("..")).not.toBe("..");
    expect(sanitizeName(".env").startsWith(".")).toBe(false);
  });
  it("caps the length at 200", () => {
    expect(sanitizeName("a".repeat(500))).toHaveLength(200);
  });
  it("falls back to file for an empty name", () => {
    expect(sanitizeName("")).toBe("file");
  });
});

// ---------------------------------------------------------------------------------------------
// @tempo/protocol redact — 05 Secrets; reconnectDelay — 02 "Client reconnect"
// ---------------------------------------------------------------------------------------------

describe("redact", () => {
  // 05: "The log helper redacts any field whose name matches /token|key|secret|password|authorization|auth_json|cookie/i."
  it.each([
    "token",
    "TEMPOD_TOKEN",
    "githubToken",
    "access_token",
    "key",
    "apiKey",
    "x-api-key",
    "privateKey",
    "secret",
    "clientSecret",
    "password",
    "Authorization",
    "auth_json",
    "cookie",
    "Set-Cookie",
  ])("redacts the field %s", (field) => {
    expect(redact({ [field]: "v" })).toEqual({ [field]: REDACTED });
  });
  it("keeps fields that do not match", () => {
    const entry = {
      ts: 1,
      method: "GET",
      host: "api.github.com",
      path: "/x",
      status: 200,
      ms: 3,
      rule: 3,
      workspaceId: "w",
    };
    expect(redact(entry)).toEqual(entry);
  });
  it("redacts the whole value of a matching field, even an object", () => {
    expect(redact({ auth: 1, auth_json: { tokens: { a: 1 } } })).toEqual({ auth: 1, auth_json: REDACTED });
  });
  it("redacts nested objects and arrays", () => {
    expect(
      redact({
        req: { headers: { authorization: "Bearer x", accept: "*/*" } },
        list: [{ apiKey: "k", n: 1 }],
      }),
    ).toEqual({
      req: { headers: { authorization: REDACTED, accept: "*/*" } },
      list: [{ apiKey: REDACTED, n: 1 }],
    });
  });
  it("returns primitives and null unchanged", () => {
    expect(redact("token")).toBe("token");
    expect(redact(5)).toBe(5);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
  it("does not mutate its input", () => {
    const input = { token: "t", nested: { password: "p" } };
    redact(input);
    expect(input).toEqual({ token: "t", nested: { password: "p" } });
  });
  it("terminates on a cyclic object", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
  // Regression (fixed): past depth 8 redact returns the raw nested object, so a deeply nested secret field is not redacted.
  it("redacts a matching field at any depth", () => {
    let v: Record<string, unknown> = { token: "deep-secret" };
    for (let i = 0; i < 12; i++) v = { child: v };
    expect(JSON.stringify(redact(v))).not.toContain("deep-secret");
  });
});

describe("reconnectDelay", () => {
  // 02: "Client reconnect: 0.5 s, then double up to 10 s, with 20% jitter."
  const mid = () => 0.5;
  it("starts at 0.5 s and doubles up to 10 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((a) => reconnectDelay(a, mid))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000,
    ]);
  });
  it("applies at most 20% jitter either way", () => {
    expect(reconnectDelay(0, () => 0)).toBe(400);
    expect(reconnectDelay(0, () => 0.999999)).toBe(600);
    expect(reconnectDelay(10, () => 0)).toBe(8000);
    expect(reconnectDelay(10, () => 0.999999)).toBe(12_000);
  });
  it("stays within ±20% with the default random source", () => {
    for (let i = 0; i < 200; i++) {
      const v = reconnectDelay(3);
      expect(v).toBeGreaterThanOrEqual(3200);
      expect(v).toBeLessThanOrEqual(4800);
    }
  });
});

describe("home backup credential boundary", () => {
  it("excludes credentials and all daemon state, including SQLite outbox journals", () => {
    for (const path of [
      ".codex/auth.json",
      ".claude/.credentials.json",
      ".tempod/tempod.db",
      ".tempod/tempod.db-wal",
      ".tempod/tempod.db-shm",
      ".tempod/ckpt.bundle",
    ]) {
      expect(
        HOME_EXCLUDES.some((excluded) =>
          excluded.endsWith("/") ? path.startsWith(excluded) : path === excluded,
        ),
      ).toBe(true);
    }
    for (const path of [
      ".claude/projects/-workspace/session.jsonl",
      ".codex/sessions/session.jsonl",
      ".pi/pi-acp/session-map.json",
    ]) {
      expect(
        HOME_EXCLUDES.some((excluded) =>
          excluded.endsWith("/") ? path.startsWith(excluded) : path === excluded,
        ),
      ).toBe(false);
    }
  });
});
