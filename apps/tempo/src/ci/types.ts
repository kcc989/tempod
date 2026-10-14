import type { CiJobConclusion } from "@tempo/protocol";

/** What RepositoryCiDO sends a runner to start one job (10, Execution). */
export interface CiJobStart {
  readonly projectId: string;
  readonly runId: string;
  readonly jobKey: string;
  readonly token: string;
  readonly userId: string;
  readonly repoName: string;
  readonly artifactRepoId: string;
  readonly cloneUrl: string;
  readonly branch: string;
  readonly sha: string;
  readonly command: string;
  readonly timeoutMinutes: number;
  readonly egressAllowlist: ReadonlyArray<string>;
}

/** A runner's result for one job; accepted only with the token it was started with. */
export interface CiJobResult {
  readonly runId: string;
  readonly jobKey: string;
  readonly token: string;
  readonly conclusion: Extract<CiJobConclusion, "success" | "failure" | "timed_out">;
  readonly exitCode: number | null;
  readonly summary: string | null;
}

/** The coordinator method a runner calls (10, Execution). */
export interface CiCoordinator {
  jobFinished(result: CiJobResult): Promise<void>;
}

export const ciRunnerName = (runId: string, jobKey: string): string => `ci:${runId}:${jobKey}`;

export const ciLogKey = (projectId: string, runId: string, jobKey: string): string =>
  `ci/${projectId}/${runId}/${jobKey}.log`;

export const CI_LOG_MAX_BYTES = 1024 * 1024;

export const CI_LOG_DROPPED = "[tempo: earlier output dropped]\n";

export interface LogTail {
  readonly text: string;
  readonly cut: boolean;
}

/** Keeps the last `max` bytes of `text`; the cut never splits a character. */
export const keepTail = (text: string, max = CI_LOG_MAX_BYTES): LogTail => {
  if (text.length * 3 <= max) return { text, cut: false };
  const bytes = new TextEncoder().encode(text);

  if (bytes.byteLength <= max) return { text, cut: false };
  let start = bytes.byteLength - max;

  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;

  return { text: new TextDecoder().decode(bytes.subarray(start)), cut: true };
};
