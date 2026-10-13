import { and, desc, eq } from "drizzle-orm";
import type { ContentBlock, RoleFile } from "@tempo/protocol";
import { items, runs, turns } from "../db/workspace-do.ts";
import { EMPTY_PROMPT, json } from "../db/json.ts";
import type { WorkspaceCore } from "../do/workspace/core.ts";
import { requireTempod } from "../do/workspace/container.ts";

export const cutInput = (text: string, limit: number): string => {
  const bytes = new TextEncoder().encode(text);

  if (bytes.length <= limit) return text;
  const marker = "[cut by Tempo]";

  if (limit < marker.length) return "";
  const prefix = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, limit - marker.length));

  return prefix.replace(/\uFFFD$/, "") + marker;
};

export const roleInputs = async (
  core: WorkspaceCore,
  file: RoleFile,
  changeId: string,
  requestText: string | undefined,
): Promise<ContentBlock[]> => {
  const blocks: ContentBlock[] = [];
  let remaining = 512 * 1024;

  for (const input of file.inputs) {
    let value = "(none)";

    if (input === "prompt") {
      const turn = core.db
        .select()
        .from(turns)
        .where(and(eq(turns.changeId, changeId), eq(turns.origin, "user")))
        .orderBy(desc(turns.seq))
        .get();

      value = requestText ?? (turn ? json.prompt.read(turn.promptJson, EMPTY_PROMPT).text : "(none)");
    } else if (input === "diff") {
      const tempod = requireTempod(core);
      const changes = await tempod.request("git.changes", { scope: "branch" });
      const parts = [JSON.stringify(changes)];
      let bytes = new TextEncoder().encode(parts[0]).length;

      for (const f of changes.files) {
        if (bytes >= Math.min(256 * 1024, remaining)) break;
        const { diff } = await tempod.request("git.fileDiff", { scope: "branch", path: f.path });
        parts.push(diff);
        bytes += new TextEncoder().encode(diff).length;
      }

      value = parts.join("\n");
    } else {
      if (input === "plan") {
        const plans = core.db
          .select({ content: items.contentJson })
          .from(items)
          .innerJoin(turns, eq(items.turnId, turns.id))
          .where(and(eq(turns.changeId, changeId), eq(items.kind, "plan")))
          .orderBy(desc(items.createdAt))
          .get();

        if (plans) value = plans.content;
      }

      if (value === "(none)") {
        const name = input === "plan" ? "planner" : input.slice(7);

        const run = core.db
          .select()
          .from(runs)
          .where(and(eq(runs.changeId, changeId), eq(runs.handle, name), eq(runs.status, "completed")))
          .orderBy(desc(runs.endedAt))
          .get();

        value = run?.resultJson ?? "(none)";
      }
    }

    const capped = cutInput(value, Math.min(256 * 1024, remaining));
    remaining -= new TextEncoder().encode(capped).length;
    blocks.push({ type: "text", text: capped });
  }

  return blocks;
};
