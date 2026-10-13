import { artifactRoute, type Artifact, type ArtifactKind } from "@tempo/protocol";

/** Pure helpers for artifacts in the web UI (04, Artifacts tab and Artifact tab). */

export interface ArtifactGroup {
  readonly id: string;
  /** Newest first. */
  readonly versions: ReadonlyArray<Artifact>;
}

/** One group per artifact, newest version first, groups by their newest version's time. */
export const artifactGroups = (list: ReadonlyArray<Artifact>): ArtifactGroup[] => {
  const byId = new Map<string, Artifact[]>();
  for (const a of list) {
    const versions = byId.get(a.id) ?? [];
    versions.push(a);
    byId.set(a.id, versions);
  }
  return [...byId.entries()]
    .map(([id, versions]) => ({ id, versions: versions.sort((a, b) => b.version - a.version) }))
    .sort((a, b) => b.versions[0]!.createdAt - a.versions[0]!.createdAt || (a.id < b.id ? 1 : -1));
};

/** `v<version>` when the version is above 1, else empty (04, artifact card). */
export const versionLabel = (version: number): string => (version > 1 ? `v${version}` : "");

export const artifactSrc = (workspaceId: string, artifactId: string, version: number, download = false) =>
  artifactRoute(workspaceId, artifactId, version, download);

/** Kinds that render only from the artifact host (05). */
export const isFramed = (kind: ArtifactKind): boolean => kind === "pdf" || kind === "html";

/** 04 Artifact tab: HTML iframes get exactly these sandbox flags. */
export const ARTIFACT_HTML_SANDBOX = "allow-scripts allow-forms allow-modals allow-downloads";

/** A workspace path for the file link in the Artifact tab, or null outside /workspace. */
export const workspaceRelative = (path: string): string | null =>
  path.startsWith("/workspace/") && path.length > "/workspace/".length
    ? path.slice("/workspace/".length)
    : null;

const IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

const extOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** 04 file tabs: the raster image types shown as images; SVG is separate. */
export const rasterMimeOf = (path: string): string | null => IMAGE_MIMES[extOf(path)] ?? null;
export const isSvgPath = (path: string): boolean => extOf(path) === "svg";
export const isImagePath = (path: string): boolean => rasterMimeOf(path) !== null || isSvgPath(path);
export const isMarkdownPath = (path: string): boolean => ["md", "markdown"].includes(extOf(path));

export const base64DataUrl = (mime: string, base64: string): string => `data:${mime};base64,${base64}`;

/** SVG renders only through `<img>` (05); a data URL keeps it out of the document. */
export const svgDataUrl = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** A file's bytes as an `<img>` source: SVG from text or base64, raster from base64. */
export const imageDataUrl = (
  path: string,
  file: { readonly content: string; readonly encoding: "utf8" | "base64" },
): string | null => {
  if (isSvgPath(path))
    return file.encoding === "utf8" ? svgDataUrl(file.content) : base64DataUrl("image/svg+xml", file.content);
  const mime = rasterMimeOf(path);
  return mime && file.encoding === "base64" ? base64DataUrl(mime, file.content) : null;
};
