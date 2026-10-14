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
