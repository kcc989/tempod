import { Schema } from "effect";
import type { FnInput } from "@tempo/protocol";

export const RepositoryTab = Schema.Literals(["code", "commits", "pulls", "issues"]);

export type RepositoryTab = typeof RepositoryTab.Type;

export interface RepositorySearch {
  readonly project?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly file?: string;
  readonly pull?: number;
  readonly issue?: number;
  readonly tab?: RepositoryTab;
}

export const isRepositoryTab = Schema.is(RepositoryTab);

export function repositorySearch(search: Schema.JsonObject): RepositorySearch {
  let result: RepositorySearch = {};

  for (const key of ["project", "ref", "path", "file"] as const) {
    const value = search[key];

    if (Schema.is(Schema.String)(value) && value) Object.assign(result, { [key]: value });
  }

  for (const key of ["pull", "issue"] as const) {
    const rawNumber = search[key];
    let number = Number.NaN;

    if (Schema.is(Schema.Number)(rawNumber)) number = rawNumber;
    else if (Schema.is(Schema.String)(rawNumber)) number = Number(rawNumber);

    if (Number.isSafeInteger(number) && number > 0) Object.assign(result, { [key]: number });
  }

  if (isRepositoryTab(search["tab"])) result = { ...result, tab: search["tab"] };

  return result;
}

export function repositoryInput(projectId: string, ref?: string, path?: string): FnInput<"getRepository"> {
  let input: FnInput<"getRepository"> = { projectId };

  if (ref) input = { ...input, ref };

  if (path !== undefined) input = { ...input, path };

  return input;
}

export function repositoryCommitsInput(
  projectId: string,
  ref: string | undefined,
  offset: number,
): FnInput<"listRepositoryCommits"> {
  let input: FnInput<"listRepositoryCommits"> = { projectId, offset };

  if (ref) input = { ...input, ref };

  return input;
}

export const parentPath = (path: string): string => path.split("/").slice(0, -1).join("/");

export const shortSha = (sha: string): string => sha.slice(0, 7);

export const commitTitle = (message: string): string => message.split("\n")[0] ?? message;

export function importUrlError(value: string): string | null {
  try {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      ? null
      : "Use an HTTPS Git URL without credentials.";
  } catch {
    return "Enter a valid HTTPS Git URL.";
  }
}

export const isSubmitShortcut = (
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean => event.code === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
