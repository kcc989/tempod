import { Schema } from "effect";

/** Agent artifacts (01, Artifacts; 02; 05, Artifact access). */

export const ARTIFACT_KINDS = ["image", "markdown", "pdf", "html", "text"] as const;

export const ArtifactKind = Schema.Literals(ARTIFACT_KINDS);

export type ArtifactKind = typeof ArtifactKind.Type;

export const ARTIFACT_STATUSES = ["uploading", "ready", "lost"] as const;

export const ArtifactStatus = Schema.Literals(ARTIFACT_STATUSES);

export type ArtifactStatus = typeof ArtifactStatus.Type;

/** 01, Allowed files: extension (lowercase, no dot) → mime and kind. */
export const ARTIFACT_TYPES = {
  png: { mime: "image/png", kind: "image" },
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  gif: { mime: "image/gif", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
  avif: { mime: "image/avif", kind: "image" },
  svg: { mime: "image/svg+xml", kind: "image" },
  md: { mime: "text/markdown", kind: "markdown" },
  markdown: { mime: "text/markdown", kind: "markdown" },
  pdf: { mime: "application/pdf", kind: "pdf" },
  html: { mime: "text/html", kind: "html" },
  htm: { mime: "text/html", kind: "html" },
  txt: { mime: "text/plain", kind: "text" },
  log: { mime: "text/plain", kind: "text" },
  json: { mime: "application/json", kind: "text" },
  csv: { mime: "text/csv", kind: "text" },
} satisfies Readonly<Record<string, { readonly mime: string; readonly kind: ArtifactKind }>>;

/** The type of a file name by its extension, case-insensitive; null when it cannot be published. */
export const artifactTypeOf = (name: string): { mime: string; kind: ArtifactKind } | null => {
  const dot = name.lastIndexOf(".");

  if (dot < 0) return null;

  const extension = name.slice(dot + 1).toLowerCase();

  return Object.entries(ARTIFACT_TYPES).find(([key]) => key === extension)?.[1] ?? null;
};

/** 01: at most 25 MiB per version. */
export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

export const ARTIFACT_TITLE_MAX = 120;

export const ARTIFACT_SUMMARY_MAX = 500;

/** 01, Scripts env `TEMPO_ARTIFACTS_DIR`. */
export const TEMPO_ARTIFACTS_DIR = "/home/tempo/artifacts";

export const ARTIFACT_TOOL_DESCRIPTION =
  "Show a file to the user in Tempo. Use it for plans, reports, screenshots, diagrams, PDFs and small HTML apps that help the user understand or review your work. The file must be inside /workspace or $TEMPO_ARTIFACTS_DIR. Publish the same path again to replace what the user sees with a new version. Markdown may contain mermaid code blocks. HTML runs offline as one file: it cannot load or send anything over the network, so inline all scripts, styles, fonts and images.";

/** 01 Publish: the answers tempod gives the tool. */
export const ARTIFACT_MESSAGES = {
  path: "Path must be a file inside /workspace or $TEMPO_ARTIFACTS_DIR.",
  type: "This file type cannot be published. Use one of: png, jpg, gif, webp, avif, svg, md, pdf, html, txt, log, json, csv.",
  size: "Artifacts are limited to 25 MiB.",
} as const;

export const publishedText = (title: string, version: number): string =>
  `Published "${title}" as version ${version}. The user can open it in Tempo.`;

/** `POST /artifacts` on mcp.sock (01, Tempo MCP server). */
export const PublishArtifactRequest = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.String.check(Schema.isMinLength(1)),
  title: Schema.String.check(Schema.isBetweenLength(1, ARTIFACT_TITLE_MAX)),
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(ARTIFACT_SUMMARY_MAX))),
});

export type PublishArtifactRequest = typeof PublishArtifactRequest.Type;

export const PublishArtifactResponse = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ error: Schema.String }),
]);

export type PublishArtifactResponse = typeof PublishArtifactResponse.Type;

/** 02 Item model: content of an `artifact` item. */
export const ArtifactItemContent = Schema.Struct({
  artifactId: Schema.String,
  version: Schema.Number,
  title: Schema.String,
  summary: Schema.optional(Schema.String),
  name: Schema.String,
  path: Schema.String,
  mime: Schema.String,
  artifactKind: ArtifactKind,
  size: Schema.Number,
});

export type ArtifactItemContent = typeof ArtifactItemContent.Type;

/** 02 Shared types: one artifact version. */
export const Artifact = Schema.Struct({
  id: Schema.String,
  version: Schema.Number,
  sessionId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  itemId: Schema.String,
  path: Schema.String,
  name: Schema.String,
  title: Schema.String,
  summary: Schema.NullOr(Schema.String),
  mime: Schema.String,
  kind: ArtifactKind,
  size: Schema.Number,
  sha256: Schema.String,
  status: ArtifactStatus,
  createdAt: Schema.Number,
});

export type Artifact = typeof Artifact.Type;

/** 02 R2 layout. */
export const artifactR2Key = (workspaceId: string, artifactId: string, version: number, name: string) =>
  `artifacts/${workspaceId}/${artifactId}/${version}/${name}`;

/** The artifact route on APP_HOST (02). */
export const artifactRoute = (workspaceId: string, artifactId: string, version: number, download = false) =>
  `/api/workspaces/${workspaceId}/artifacts/${artifactId}/${version}${download ? "?download=1" : ""}`;

/** 05 Artifact access: the first label of an artifact host. */
export const ARTIFACT_HOST_LABEL = /^a-([0-9a-hjkmnp-tv-z]{26})-([0-9a-hjkmnp-tv-z]{26})$/;
