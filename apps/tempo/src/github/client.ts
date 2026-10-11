import { TempoError, type ErrorCode } from "@tempo/protocol";
import { log } from "../log.ts";

const API = "https://api.github.com";
const UA = "tempo";

export interface GithubRequest {
  readonly method?: string;
  readonly path: string;
  readonly token: string;
  readonly tokenType?: "Bearer" | "token";
  readonly body?: unknown;
  readonly query?: Record<string, string | number | undefined>;
  /** Maps a 4xx status (and body) to a Tempo error code. */
  readonly mapError?: (status: number, body: GithubErrorBody) => ErrorCode | undefined;
}

export interface GithubErrorBody {
  readonly message?: string;
  readonly errors?: ReadonlyArray<{ message?: string; code?: string }>;
}

export class GithubHttpError extends TempoError {
  constructor(
    code: ErrorCode,
    readonly status: number,
    readonly body: GithubErrorBody,
  ) {
    super(code, undefined, `GitHub ${status}: ${body.message ?? "error"}`.slice(0, 500));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One GitHub REST call. 5xx and network errors retry 3 times with backoff; 4xx never retries and
 * maps to the matching code, else GITHUB_API_ERROR (03, Failure handling).
 */
export const githubFetch = async <T>(req: GithubRequest): Promise<T> => {
  const url = new URL(API + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(url, {
        method: req.method ?? "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `${req.tokenType ?? "Bearer"} ${req.token}`,
          "User-Agent": UA,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
    } catch (e) {
      lastError = e;
      continue;
    }
    if (res.status >= 500) {
      lastError = new GithubHttpError("GITHUB_API_ERROR", res.status, await safeJson(res));
      continue;
    }
    if (res.status >= 400) {
      const body = await safeJson(res);
      const code = req.mapError?.(res.status, body) ?? "GITHUB_API_ERROR";
      log("warn", "github api error", { status: res.status, path: req.path });
      throw new GithubHttpError(code, res.status, body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  if (lastError instanceof TempoError) throw lastError;
  throw new TempoError("GITHUB_API_ERROR", undefined, String(lastError).slice(0, 300));
};

const safeJson = async (res: Response): Promise<GithubErrorBody> => {
  try {
    return (await res.json()) as GithubErrorBody;
  } catch {
    return {};
  }
};

/** Follows `page` until a short page. GitHub caps per_page at 100. */
export const githubPaginate = async <T>(req: GithubRequest, limit: number, pick?: (page: unknown) => T[]): Promise<T[]> => {
  const out: T[] = [];
  for (let page = 1; out.length < limit && page <= 50; page++) {
    const res = await githubFetch<unknown>({ ...req, query: { ...req.query, per_page: 100, page } });
    const items = pick ? pick(res) : (res as T[]);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out.slice(0, limit);
};
