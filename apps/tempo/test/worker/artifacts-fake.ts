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
