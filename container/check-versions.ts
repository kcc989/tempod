// CI check (01, Container image): the Dockerfile and versions.json must agree.
import { readFileSync } from "node:fs";

const dir = new URL(".", import.meta.url);
const versions = JSON.parse(readFileSync(new URL("versions.json", dir), "utf8")) as {
  base_image: string;
  base_image_digest: string | null;
  sandbox_shim: string;
  npm: Record<string, string>;
  build_args: Record<string, string>;
};
const dockerfile = readFileSync(new URL("Dockerfile", dir), "utf8");
const errors: string[] = [];

const base = /^ARG BASE_IMAGE=(\S+)$/m.exec(dockerfile)?.[1];
const expectedBase = versions.base_image_digest
  ? `${versions.base_image}@${versions.base_image_digest}`
  : versions.base_image;
if (base !== expectedBase) errors.push(`BASE_IMAGE is ${base}, versions.json says ${expectedBase}`);

for (const [pkg, version] of Object.entries(versions.npm)) {
  const re = new RegExp(`${pkg.replace(/[/@.]/g, (c) => `\\${c}`)}@([^\\s\\\\]+)`);
  const found = re.exec(dockerfile)?.[1];
  const expected = pkg === "@playwright/mcp" ? "${PLAYWRIGHT_MCP_VERSION}" : version;
  if (found !== expected)
    errors.push(`${pkg} is ${found ?? "missing"} in the Dockerfile, versions.json says ${version}`);
}
if (versions.npm["@playwright/mcp"] !== versions.build_args["PLAYWRIGHT_MCP_VERSION"]) {
  errors.push("@playwright/mcp and PLAYWRIGHT_MCP_VERSION differ in versions.json");
}
for (const arg of Object.keys(versions.build_args)) {
  if (!new RegExp(`^ARG ${arg}$`, "m").test(dockerfile))
    errors.push(`ARG ${arg} is missing from the Dockerfile`);
}
if (!dockerfile.includes("tini=${TINI_VERSION}"))
  errors.push("tini must use TINI_VERSION from versions.json");
if (!dockerfile.includes('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tempod"]'))
  errors.push("tini must launch tempod as the workspace entrypoint");
const shim = /COPY --from=(\S+) \/usr\/local\/bin\/sandbox-shim/.exec(dockerfile)?.[1];
if (shim !== versions.sandbox_shim)
  errors.push(`sandbox shim is ${shim}, versions.json says ${versions.sandbox_shim}`);
if (/--omit=optional/.test(dockerfile))
  errors.push("--omit=optional is not allowed (the claude binary is an optional dependency)");

if (errors.length) {
  for (const e of errors) console.error(`versions: ${e}`);
  process.exit(1);
}
console.log("container/Dockerfile matches container/versions.json");
