import { TempoError } from "@tempo/protocol";

/**
 * A minimal Git writer for full-snapshot commits (01, Shell and dotfiles): loose objects, an
 * undeltified v2 pack, and one ref update over smart HTTP `git-receive-pack`.
 */

export type GitObjectType = "commit" | "tree" | "blob";

export interface GitObject {
  readonly type: GitObjectType;
  readonly body: Uint8Array;
  readonly sha: string;
}

export interface GitFile {
  readonly path: string;
  readonly content: string;
}

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export const ZERO_SHA = "0".repeat(40);

const utf8 = new TextEncoder();

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;

  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }

  return out;
};

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const unhex = (sha: string): Uint8Array => {
  const out = new Uint8Array(20);

  for (let i = 0; i < 20; i++) out[i] = Number.parseInt(sha.slice(i * 2, i * 2 + 2), 16);

  return out;
};

const sha1 = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));

export const gitObject = async (type: GitObjectType, body: Uint8Array): Promise<GitObject> => {
  const header = utf8.encode(`${type} ${body.byteLength}\0`);

  return { type, body, sha: hex(await sha1(concat([header, body]))) };
};

interface Dir {
  readonly files: Map<string, string>;
  readonly dirs: Map<string, Dir>;
}

const newDir = (): Dir => ({ files: new Map(), dirs: new Map() });

/** Git orders tree entries by name bytes, comparing a subtree as if its name ended in "/". */
const entryKey = (name: string, isTree: boolean): Uint8Array => utf8.encode(isTree ? `${name}/` : name);

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;

  return a.length - b.length;
};

const writeDir = async (dir: Dir, out: GitObject[]): Promise<GitObject> => {
  const entries: Array<{ mode: string; name: string; sha: string; key: Uint8Array }> = [];

  for (const [name, content] of dir.files) {
    const blob = await gitObject("blob", utf8.encode(content));
    out.push(blob);
    entries.push({ mode: "100644", name, sha: blob.sha, key: entryKey(name, false) });
  }

  for (const [name, sub] of dir.dirs) {
    const tree = await writeDir(sub, out);
    entries.push({ mode: "40000", name, sha: tree.sha, key: entryKey(name, true) });
  }

  entries.sort((a, b) => compareBytes(a.key, b.key));
  const body = concat(entries.flatMap((e) => [utf8.encode(`${e.mode} ${e.name}\0`), unhex(e.sha)]));
  const tree = await gitObject("tree", body);
  out.push(tree);

  return tree;
};

/** Blobs and trees for a flat file list; the root tree is the last object. Paths are already validated. */
export const buildTree = async (
  files: ReadonlyArray<GitFile>,
): Promise<{ root: string; objects: GitObject[] }> => {
  const root = newDir();

  for (const file of files) {
    const segments = file.path.split("/");
    let dir = root;

    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment);

      if (!next) {
        next = newDir();
        dir.dirs.set(segment, next);
      }

      dir = next;
    }

    dir.files.set(segments.at(-1)!, file.content);
  }

  const objects: GitObject[] = [];
  const tree = await writeDir(root, objects);
  const unique = new Map(objects.map((o) => [o.sha, o]));

  return { root: tree.sha, objects: [...unique.values()] };
};

/** Name and email may not break the commit header. */
const identityText = (who: GitIdentity, seconds: number): string =>
  `${who.name.replace(/[<>\n\r\0]/g, "").trim() || "Tempo"} <${who.email.replace(/[<>\n\r\0\s]/g, "") || "tempo@localhost"}> ${seconds} +0000`;

export const buildCommit = (input: {
  readonly tree: string;
  readonly parent: string | null;
  readonly author: GitIdentity;
  readonly message: string;
  readonly at: number;
}): Promise<GitObject> => {
  const who = identityText(input.author, Math.floor(input.at / 1000));
  const parent = input.parent ? `parent ${input.parent}\n` : "";
  const text = `tree ${input.tree}\n${parent}author ${who}\ncommitter ${who}\n\n${input.message.trimEnd()}\n`;

  return gitObject("commit", utf8.encode(text));
};

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

const deflate = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );

const objectHeader = (type: GitObjectType, size: number): Uint8Array => {
  const out: number[] = [];
  let byte = (TYPE_CODE[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);

  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }

  out.push(byte);

  return new Uint8Array(out);
};

/** A version 2 pack of whole (undeltified) objects, ending in the SHA-1 of everything before it. */
export const buildPack = async (objects: ReadonlyArray<GitObject>): Promise<Uint8Array<ArrayBuffer>> => {
  const head = new Uint8Array(12);
  head.set(utf8.encode("PACK"), 0);
  const view = new DataView(head.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [head];

  for (const o of objects) {
    parts.push(objectHeader(o.type, o.body.byteLength));
    parts.push(await deflate(concat([o.body])));
  }

  const body = concat(parts);

  return concat([body, await sha1(body)]);
};

export const pktLine = (text: string): Uint8Array => {
  const bytes = utf8.encode(text);

  return concat([utf8.encode((bytes.byteLength + 4).toString(16).padStart(4, "0")), bytes]);
};

const FLUSH = utf8.encode("0000");

/** The receive-pack request body: one update command, a flush, then the pack. */
export const receivePackBody = (
  update: { readonly old: string; readonly next: string; readonly ref: string },
  pack: Uint8Array,
): Uint8Array<ArrayBuffer> =>
  concat([pktLine(`${update.old} ${update.next} ${update.ref}\0report-status\n`), FLUSH, pack]);

export type PushResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Parses a report-status response (no side band) for one ref. */
export const parseReportStatus = (bytes: Uint8Array, ref: string): PushResult => {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let offset = 0;

  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);

    if (
      !Number.isFinite(length) ||
      (length !== 0 && length < 4) ||
      offset + Math.max(length, 4) > bytes.length
    )
      throw new TempoError(
        "ARTIFACTS_API_ERROR",
        undefined,
        "Artifacts Git returned an invalid push report.",
      );
    offset += 4;

    if (length === 0) continue;
    lines.push(decoder.decode(bytes.subarray(offset, offset + length - 4)).replace(/\n$/, ""));
    offset += length - 4;
  }

  const unpack = lines.find((l) => l.startsWith("unpack "));

  if (unpack !== "unpack ok")
    throw new TempoError("ARTIFACTS_API_ERROR", undefined, "Artifacts Git could not unpack the push.");

  if (lines.includes(`ok ${ref}`)) return { ok: true };
  const ng = lines.find((l) => l.startsWith(`ng ${ref} `));

  if (ng) return { ok: false, reason: ng.slice(`ng ${ref} `.length).slice(0, 200) };

  throw new TempoError("ARTIFACTS_API_ERROR", undefined, "Artifacts Git did not report the pushed branch.");
};

const MAX_REPORT_BYTES = 64 * 1024;

/**
 * Pushes `objects` and moves `ref` from `old` to `next` in one request. `remote` must already be
 * checked with assertArtifactRemote. The token is sent only in the Authorization header.
 */
export const pushObjects = async (input: {
  readonly remote: URL;
  readonly token: string;
  readonly ref: string;
  readonly old: string;
  readonly next: string;
  readonly objects: ReadonlyArray<GitObject>;
}): Promise<PushResult> => {
  const url = new URL(input.remote);
  url.pathname += "/git-receive-pack";
  const pack = await buildPack(input.objects);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/x-git-receive-pack-request",
      Accept: "application/x-git-receive-pack-result",
      "User-Agent": "tempo",
    },
    body: receivePackBody({ old: input.old, next: input.next, ref: input.ref }, pack),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok)
    throw new TempoError("ARTIFACTS_API_ERROR", undefined, `Artifacts Git returned HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.byteLength > MAX_REPORT_BYTES)
    throw new TempoError("ARTIFACTS_API_ERROR", undefined, "The Git push report is too large.");

  return parseReportStatus(bytes, input.ref);
};
