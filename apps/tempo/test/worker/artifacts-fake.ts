const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected Artifacts operation");
};

export const artifactMetadata = (
  name: string,
  overrides: Partial<ArtifactsRepoInfo> = {},
): ArtifactsRepoInfo => ({
  id: `repo-${name}`,
  name,
  description: null,
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastPushAt: null,
  source: null,
  readOnly: false,
  remote: `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/tempo-repos/${name}.git`,
  ...overrides,
});

export const artifactCommit = (
  hash: string,
  overrides: Partial<ArtifactsCommitMetadata> = {},
): ArtifactsCommitMetadata => ({
  hash,
  treeHash: "e".repeat(40),
  message: "Branch tip",
  author: { name: "Owner", email: "owner@example.com" },
  committer: { name: "Owner", email: "owner@example.com" },
  parents: [],
  authoredAt: 1_791_867_600,
  committedAt: 1_791_867_600,
  ...overrides,
});

export const fakeArtifactRepo = (
  info: ArtifactsRepoInfo,
  overrides: Partial<ArtifactsRepo> = {},
): ArtifactsRepo => ({
  info: async () => info,
  createToken: unexpected,
  listTokens: unexpected,
  revokeToken: unexpected,
  log: unexpected,
  readCommit: unexpected,
  readTree: unexpected,
  readBlob: unexpected,
  readFile: unexpected,
  fork: unexpected,
  [Symbol.dispose]() {},
  ...overrides,
});

export const fakeArtifacts = (get: Artifacts["get"], overrides: Partial<Artifacts> = {}): Artifacts => ({
  get,
  create: unexpected,
  import: unexpected,
  list: unexpected,
  delete: unexpected,
  ...overrides,
});

const inflate = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );

const adler32 = (bytes: Uint8Array): number => {
  let a = 1;
  let b = 0;

  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }

  return ((b << 16) | a) >>> 0;
};

const OBJECT_TYPES = ["", "commit", "tree", "blob"];

/** Decodes an undeltified pack. A zlib stream does not record its length, so each one is found by size. */
const unpack = async (pack: Uint8Array): Promise<Array<{ type: string; body: Uint8Array }>> => {
  if (new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK") throw new Error("not a pack");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const count = view.getUint32(8);
  const objects: Array<{ type: string; body: Uint8Array }> = [];
  let offset = 12;

  for (let n = 0; n < count; n++) {
    let byte = pack[offset++]!;
    const type = OBJECT_TYPES[(byte >> 4) & 7] ?? "";
    let size = byte & 0x0f;
    let shift = 4;

    while (byte & 0x80) {
      byte = pack[offset++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }

    for (let end = offset + 8; ; end++) {
      if (end > pack.length - 20) throw new Error("truncated pack object");
      const body = await inflate(pack.subarray(offset, end)).catch(() => null);

      if (body && body.byteLength === size && view.getUint32(end - 4) === adler32(body)) {
        objects.push({ type, body });
        offset = end;
        break;
      }
    }
  }

  return objects;
};

const pkt = (text: string): string =>
  (new TextEncoder().encode(text).length + 4).toString(16).padStart(4, "0") + text;

const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * An Artifacts repository with real Git objects: smart HTTP ref advertisement and receive-pack
 * for `fetch`, and readCommit, readTree and readBlob for the binding.
 */
export const fakeGitRemote = (info: ArtifactsRepoInfo) => {
  const objects = new Map<string, { type: string; body: Uint8Array }>();
  const refs = new Map<string, string>();
  const pushes: Array<{ authorization: string | null; old: string; next: string; ref: string }> = [];
  const decoder = new TextDecoder();

  const hash = async (type: string, body: Uint8Array) => {
    const header = new TextEncoder().encode(`${type} ${body.byteLength}\0`);
    const all = new Uint8Array(header.byteLength + body.byteLength);
    all.set(header);
    all.set(body, header.byteLength);

    return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-1", all)));
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // workerd's Request rejects redirect: "error"; the remote never redirects.
    const request = new Request(input, { ...init, redirect: "manual" });
    const url = new URL(request.url);
    const base = new URL(info.remote).pathname;

    if (url.pathname === `${base}/info/refs` && url.searchParams.get("service") === "git-upload-pack") {
      const lines = [...refs].map(([ref, sha]) => pkt(`${sha} ${ref}\n`));

      return new Response(pkt("# service=git-upload-pack\n") + "0000" + lines.join("") + "0000", {
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      });
    }

    if (url.pathname !== `${base}/git-receive-pack` || request.method !== "POST")
      return new Response("not found", { status: 404 });
    const body = new Uint8Array(await request.arrayBuffer());
    const length = Number.parseInt(decoder.decode(body.subarray(0, 4)), 16);
    const command = decoder.decode(body.subarray(4, length)).split("\0")[0]!;
    const [old = "", next = "", ref = ""] = command.split(" ");
    pushes.push({ authorization: request.headers.get("authorization"), old, next, ref });

    for (const o of await unpack(body.subarray(length + 4))) objects.set(await hash(o.type, o.body), o);
    const current = refs.get(ref) ?? "0".repeat(40);
    let status = `ok ${ref}\n`;

    if (current !== old) status = `ng ${ref} incorrect old value provided\n`;
    else if (!objects.has(next)) status = `ng ${ref} missing object\n`;
    else refs.set(ref, next);

    return new Response(pkt("unpack ok\n") + pkt(status) + "0000", {
      headers: { "Content-Type": "application/x-git-receive-pack-result" },
    });
  };

  const readCommit = async (sha: string): Promise<ArtifactsCommitMetadata | null> => {
    const o = objects.get(sha);

    if (o?.type !== "commit") return null;
    const text = decoder.decode(o.body);

    return artifactCommit(sha, {
      treeHash: /^tree ([a-f0-9]{40})$/m.exec(text)![1]!,
      parents: [...text.matchAll(/^parent ([a-f0-9]{40})$/gm)].map((m) => m[1]!),
      message: text.slice(text.indexOf("\n\n") + 2).replace(/\n$/, ""),
    });
  };

  const readTree = async (sha: string): Promise<ArtifactsTreeEntry[] | null> => {
    const o = objects.get(sha);

    if (o?.type !== "tree") return null;
    const entries: ArtifactsTreeEntry[] = [];
    let i = 0;

    while (i < o.body.length) {
      const nul = o.body.indexOf(0, i);
      const head = decoder.decode(o.body.subarray(i, nul));
      const mode = head.slice(0, head.indexOf(" "));
      const name = head.slice(head.indexOf(" ") + 1);
      const entryHash = hexOf(o.body.subarray(nul + 1, nul + 21));
      entries.push({ name, mode, hash: entryHash, type: mode === "40000" ? "tree" : "blob" });
      i = nul + 21;
    }

    return entries;
  };

  const readBlob = async (sha: string): Promise<Blob | null> => {
    const o = objects.get(sha);

    return o?.type === "blob" ? new Blob([new Uint8Array(o.body)]) : null;
  };

  return { objects, refs, pushes, fetch, readCommit, readTree, readBlob };
};
