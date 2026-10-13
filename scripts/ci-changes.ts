const DOC_PATH = /^(?:docs\/.*\.(?:md|png|jpe?g|svg)|spikes\/.*\.md|(?:README|AGENTS|CLAUDE)\.md)$/;

export const isDocsOnly = (files: readonly string[]): boolean =>
  files.length > 0 && files.every((file) => DOC_PATH.test(file));

export const changedFiles = async (
  base: string | undefined,
  cwd = process.cwd(),
): Promise<string[] | null> => {
  if (!base || !/^[a-f0-9]{40}$/.test(base) || /^0+$/.test(base)) return null;
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    return { code, output };
  };
  if ((await git(["cat-file", "-e", `${base}^{commit}`])).code !== 0) {
    if ((await git(["fetch", "--no-tags", "--depth=1", "origin", base])).code !== 0) return null;
  }
  // Include both sides of a rename so code moved into docs cannot skip its checks.
  const diff = await git(["diff", "--no-renames", "--name-only", "-z", base, "HEAD"]);
  return diff.code === 0 ? diff.output.split("\0").filter(Boolean) : null;
};

if (import.meta.main) {
  const files = await changedFiles(process.env["CI_BASE_SHA"]);
  const docsOnly = files !== null && isDocsOnly(files);
  const output = process.env["GITHUB_OUTPUT"];
  if (output) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(output, `docs_only=${docsOnly}\n`);
  }
  console.log(docsOnly ? "Documentation only: run lint and formatting." : "Run the complete CI suite.");
}
