// Resolves the base image tag to its index digest through the Docker Hub registry API and
// writes it to versions.json and the Dockerfile (01: pin the base image by digest).
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL(".", import.meta.url);
const versionsUrl = new URL("versions.json", dir);
const dockerfileUrl = new URL("Dockerfile", dir);
const versions = JSON.parse(readFileSync(versionsUrl, "utf8")) as { base_image: string; base_image_digest: string | null };

const [name, tag] = versions.base_image.split(":") as [string, string];
const repo = name.includes("/") ? name : `library/${name}`;
// Anonymous pulls share a small rate limit; DOCKERHUB_USERNAME and DOCKERHUB_TOKEN raise it.
const user = process.env["DOCKERHUB_USERNAME"];
const pass = process.env["DOCKERHUB_TOKEN"];
const auth = (await (
  await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`, {
    headers: user && pass ? { Authorization: `Basic ${btoa(`${user}:${pass}`)}` } : {},
  })
).json()) as { token: string };
const res = await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, {
  method: "HEAD",
  headers: {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json",
  },
});
const digest = res.headers.get("docker-content-digest");
if (!res.ok || !digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`could not resolve ${versions.base_image}: ${res.status}`);
versions.base_image_digest = digest;
writeFileSync(versionsUrl, `${JSON.stringify(versions, null, 2)}\n`);
writeFileSync(
  dockerfileUrl,
  readFileSync(dockerfileUrl, "utf8").replace(/^ARG BASE_IMAGE=.*$/m, `ARG BASE_IMAGE=${versions.base_image}@${digest}`),
);
console.log(`pinned ${versions.base_image}@${digest}`);
