import { describe, expect, it } from "vitest";
import { decide, type EgressConfig } from "../../src/egress/rules.ts";

const host = `${"a".repeat(32)}.artifacts.cloudflare.net`;

const remote = `https://${host}/git/tempo-repos/app.git`;

const config: EgressConfig = {
  owner: "tempo",
  repo: "app",
  provider: "artifacts",
  cloneUrl: remote,
  policy: "allowlist",
  allowlist: [],
  mcp: [],
};

const decision = (url: string, settings = config) =>
  decide(new URL(url), new Headers(), "tempo.test", settings);

describe("native repository egress", () => {
  it.each(["", "/info/refs?service=git-upload-pack", "/git-upload-pack", "/git-receive-pack"])(
    "injects the scoped credential into its Git transport endpoint %s",
    (suffix) => {
      expect(decision(remote + suffix)).toEqual({
        rule: 2,
        action: "forward",
        set: { name: "authorization", value: "artifact-bearer" },
      });
    },
  );
  it.each([
    `https://${host}/git/tempo-repos/app2.git/git-upload-pack`,
    `https://${host}/git/tempo-repos/other.git/git-upload-pack`,
    `https://${host}/git/another/app.git/git-upload-pack`,
    `https://${host}/git/tempo-repos/app.git/arbitrary-api`,
    `https://${host}:444/git/tempo-repos/app.git/git-upload-pack`,
    `https://${host}.evil.test/git/tempo-repos/app.git/git-upload-pack`,
    "https://api.cloudflare.com/client/v4/accounts/account/artifacts",
    remote.replace("https:", "http:"),
  ])("does not inject credentials into %s", (url) => {
    const result = decision(url, { ...config, policy: "open" });
    expect(result).toEqual({ rule: 8, action: "forward" });
  });
  it("blocks the application host before matching Git transport", () => {
    expect(
      decision("https://tempo.test/git/tempo-repos/app.git", {
        ...config,
        cloneUrl: "https://tempo.test/git/tempo-repos/app.git",
      }),
    ).toMatchObject({ action: "block", rule: 0 });
  });
  it("native workspaces do not mint GitHub credentials", () => {
    for (const url of ["https://github.com/tempo/app.git", "https://api.github.com/repos/tempo/app"])
      expect(decision(url)).toEqual({ rule: 9, action: "forward" });
  });
});

describe("CI job egress (10, Egress)", () => {
  const ci: EgressConfig = { ...config, ci: true, allowlist: ["*.example.com"] };

  const ciDecision = (url: string, headers: Record<string, string> = {}) =>
    decide(new URL(url), new Headers(headers), "tempo.test", ci);

  it("gives only fetch endpoints of its own remote a credential", () => {
    for (const suffix of ["/info/refs?service=git-upload-pack", "/git-upload-pack"])
      expect(ciDecision(remote + suffix)).toEqual({
        rule: 2,
        action: "forward",
        set: { name: "authorization", value: "artifact-bearer" },
      });

    for (const suffix of ["/info/refs?service=git-receive-pack", "/git-receive-pack", "", "/objects/x"])
      expect(ciDecision(remote + suffix)).toMatchObject({ rule: 2, action: "block", status: 403 });
  });

  it("adds no other credential and follows the CI allowlist", () => {
    expect(
      ciDecision("https://openrouter.ai/api", { authorization: "Bearer tempo-placeholder" }),
    ).toMatchObject({
      rule: 7,
      action: "block",
    });
    expect(ciDecision("https://api.github.com/repos/tempo/app")).toEqual({ rule: 9, action: "forward" });
    expect(ciDecision("https://pkg.example.com/x")).toEqual({ rule: 9, action: "forward" });
    expect(ciDecision("https://other.test/x")).toMatchObject({ rule: 10, action: "block" });
    expect(ciDecision("https://tempo.test/api")).toMatchObject({ rule: 0, action: "block" });
  });
});
