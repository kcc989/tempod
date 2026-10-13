import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { TempoError, type RoleFile, type RoleInfo } from "@tempo/protocol";
import { userRoles } from "../db/d1.ts";
import type { Env } from "../env.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { parseRoleFile } from "./parse.ts";
import planner from "../../../../packages/roles-builtin/planner.md?raw";
import coder from "../../../../packages/roles-builtin/coder.md?raw";
import ci from "../../../../packages/roles-builtin/ci.md?raw";
import reviewer from "../../../../packages/roles-builtin/reviewer.md?raw";

export interface ParsedRole {
  info: RoleInfo;
  text: string;
  file: RoleFile | null;
  body: string;
}

export const parseRole = async (
  name: string,
  scope: RoleInfo["scope"],
  text: string,
): Promise<ParsedRole> => {
  const sha = await sha256Hex(text);

  try {
    const { file, body } = parseRoleFile(name, text);
    const { model: _model, inputs: _inputs, ...fields } = file;

    return { info: { name, scope, sha, ...fields }, text, file, body };
  } catch {
    return {
      info: {
        name,
        scope,
        sha,
        description: "",
        agent: "auto",
        access: "read-only",
        requestable: false,
        on: [],
        limits: { rounds: 1, continues: 2, timeout: "20m", tokens: 0 },
        error: "The role file is not valid.",
      },
      text,
      file: null,
      body: "",
    };
  }
};

export const baseRoles = async (env: Env, userId: string): Promise<ParsedRole[]> => {
  const roles = await Promise.all(
    Object.entries({ planner, coder, ci, reviewer }).map(([name, text]) => parseRole(name, "builtin", text)),
  );

  const rows = await drizzle(env.DB).select().from(userRoles).where(eq(userRoles.userId, userId)).all();

  return [...roles, ...(await Promise.all(rows.map((row) => parseRole(row.name, "user", row.text))))];
};

export const withPrecedence = (roles: ParsedRole[]): ParsedRole[] => {
  const rank = { builtin: 0, user: 1, repo: 2 };

  return roles.map((r) => {
    const winner = roles
      .filter((other) => other.info.name === r.info.name)
      .sort((a, b) => rank[b.info.scope] - rank[a.info.scope])[0]!;

    const { shadowedBy: _shadowedBy, ...info } = r.info;

    return {
      ...r,
      info: winner.info.scope === r.info.scope ? info : { ...info, shadowedBy: winner.info.scope },
    };
  });
};

export const ownedRoleText = async (
  env: Env,
  userId: string,
  name: string,
  scope: RoleInfo["scope"],
): Promise<{ text: string }> => {
  const role = (await baseRoles(env, userId)).find((r) => r.info.name === name && r.info.scope === scope);

  if (!role) throw new TempoError("NOT_FOUND");

  return { text: role.text };
};

export const removeUserRole = async (env: Env, userId: string, name: string): Promise<boolean> =>
  !!(
    await drizzle(env.DB)
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.name, name)))
      .returning()
      .all()
  ).length;
