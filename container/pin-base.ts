// Resolves the base image tag to a digest and writes it to versions.json and the Dockerfile
// (01: pin the base image by digest at build time). Needs docker with buildx.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL(".", import.meta.url);
const versionsUrl = new URL("versions.json", dir);
const dockerfileUrl = new URL("Dockerfile", dir);
const versions = JSON.parse(readFileSync(versionsUrl, "utf8"));
const out = execFileSync("docker", ["buildx", "imagetools", "inspect", versions.base_image, "--format", "{{json .Manifest}}"], {
  encoding: "utf8",
});
const digest = (JSON.parse(out) as { digest: string }).digest;
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`unexpected digest ${digest}`);
versions.base_image_digest = digest;
writeFileSync(versionsUrl, `${JSON.stringify(versions, null, 2)}\n`);
const dockerfile = readFileSync(dockerfileUrl, "utf8").replace(/^ARG BASE_IMAGE=.*$/m, `ARG BASE_IMAGE=${versions.base_image}@${digest}`);
writeFileSync(dockerfileUrl, dockerfile);
console.log(`pinned ${versions.base_image}@${digest}`);
