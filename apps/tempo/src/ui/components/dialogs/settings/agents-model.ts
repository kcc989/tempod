import {
  CustomAgentDefinition,
  ENV_REF_PATTERN,
  MAX_MCP_SERVERS,
  MAX_SYSTEM_PROMPT,
  MAX_TOOL_NAMES,
  type AgentId,
  type CustomAgent,
  type McpServerDef,
} from "@tempo/protocol";
import { Schema, Option } from "effect";

/** Settings → Agents (04): the custom agent form. Pure, so it is unit-tested. */

export interface ServerForm {
  readonly key: string;
  readonly name: string;
  readonly type: "stdio" | "http" | "sse";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly url: string;
  /** `KEY=${NAME}` lines: env for stdio, headers for http and sse. */
  readonly vars: string;
}

export interface AgentForm {
  readonly name: string;
  readonly description: string;
  readonly baseAgent: AgentId;
  readonly model: string;
  readonly thoughtLevel: string;
  readonly systemPrompt: string;
  readonly allow: ReadonlyArray<string>;
  readonly deny: ReadonlyArray<string>;
  readonly playwright: boolean;
  readonly servers: ReadonlyArray<ServerForm>;
}

export const emptyForm = (): AgentForm => ({
  name: "",
  description: "",
  baseAgent: "claude",
  model: "",
  thoughtLevel: "",
  systemPrompt: "",
  allow: [],
  deny: [],
  playwright: true,
  servers: [],
});

let serverSeq = 0;

export const emptyServer = (): ServerForm => ({
  key: `server-${++serverSeq}`,
  name: "",
  type: "stdio",
  command: "",
  args: [],
  url: "",
  vars: "",
});

const varsText = (m: Readonly<Record<string, string>>): string =>
  Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

export const formFromAgent = (a: CustomAgent): AgentForm => ({
  name: a.name,
  description: a.description,
  baseAgent: a.baseAgent,
  model: a.model,
  thoughtLevel: a.thoughtLevel,
  systemPrompt: a.systemPrompt,
  allow: a.tools.allow,
  deny: a.tools.deny,
  playwright: a.mcp.playwright,
  servers: a.mcp.servers.map((s) => ({
    ...emptyServer(),
    name: s.name,
    type: s.type,
    ...(s.type === "stdio"
      ? { command: s.command, args: s.args, vars: varsText(s.env) }
      : { url: s.url, vars: varsText(s.headers) }),
  })),
});

/** What each base agent ignores (01, Custom agents table), shown below Base agent. */
export const UNSUPPORTED_NOTE: Record<AgentId, string | null> = {
  claude: null,
  codex: "Tool limits are not supported.",
  opencode: null,
  pi: "SSE MCP servers are not supported.",
};

export type FormErrors = Readonly<Record<string, string>>;

const TOOL = /^[A-Za-z0-9_.:*-]{1,128}$/;

const SERVER_NAME = /^[a-z0-9_-]{1,32}$/;

const parseVars = (text: string) => {
  const vars: Record<string, string> = {};

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (!line) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    const value = eq > 0 ? line.slice(eq + 1).trim() : "";

    if (!key)
      return { vars, error: `Write each line as NAME=\${SECRET}: ${line}` } satisfies {
        vars: Record<string, string>;
        error: string | null;
      };

    if (!ENV_REF_PATTERN.test(value))
      return { vars, error: `${key}: use \${NAME} of a project env var or secret.` } satisfies {
        vars: Record<string, string>;
        error: string | null;
      };
    vars[key] = value;
  }

  return { vars, error: null } satisfies { vars: Record<string, string>; error: string | null };
};

const toolErrors = (list: ReadonlyArray<string>): string | null => {
  if (list.length > MAX_TOOL_NAMES) return `At most ${MAX_TOOL_NAMES} tools.`;
  const bad = list.find((t) => !TOOL.test(t));

  return bad === undefined ? null : `Not a valid tool name: ${bad}`;
};

/** Field errors keyed by field (`name`, `allow`, `server.<key>.url`, …), and the definition when valid. */
export const validateForm = (form: AgentForm) => {
  const errors: Record<string, string> = {};
  const name = form.name.trim();

  if (!name) errors["name"] = "Enter a name.";
  else if (name.length > 60) errors["name"] = "At most 60 characters.";

  if (form.description.length > 200) errors["description"] = "At most 200 characters.";

  if (form.systemPrompt.length > MAX_SYSTEM_PROMPT)
    errors["systemPrompt"] = `At most ${MAX_SYSTEM_PROMPT.toLocaleString("en-US")} characters.`;
  const allow = toolErrors(form.allow);

  if (allow) errors["allow"] = allow;
  const deny = toolErrors(form.deny);

  if (deny) errors["deny"] = deny;

  if (form.servers.length > MAX_MCP_SERVERS) errors["servers"] = `At most ${MAX_MCP_SERVERS} MCP servers.`;

  const seen = new Set<string>();
  const servers: McpServerDef[] = [];

  for (const s of form.servers) {
    const at = (field: string) => `server.${s.key}.${field}`;
    const sName = s.name.trim();

    if (!SERVER_NAME.test(sName)) errors[at("name")] = "Use 1 to 32 of a-z, 0-9, - and _.";
    else if (sName === "playwright")
      errors[at("name")] = "playwright is reserved. Use the Playwright switch.";
    else if (seen.has(sName)) errors[at("name")] = "Each server needs its own name.";
    seen.add(sName);
    const { vars, error } = parseVars(s.vars);

    if (error) errors[at("vars")] = error;

    if (s.type === "stdio") {
      if (!s.command.trim()) errors[at("command")] = "Enter the command.";
      servers.push({ name: sName, type: "stdio", command: s.command.trim(), args: [...s.args], env: vars });
    } else {
      if (!/^https:\/\/\S+$/.test(s.url.trim())) errors[at("url")] = "Enter an https:// URL.";
      servers.push({ name: sName, type: s.type, url: s.url.trim(), headers: vars });
    }
  }

  if (Object.keys(errors).length > 0)
    return { errors, definition: null } satisfies {
      readonly errors: FormErrors;
      readonly definition: CustomAgentDefinition | null;
    };

  const candidate = {
    name,
    description: form.description,
    baseAgent: form.baseAgent,
    model: form.model.trim(),
    thoughtLevel: form.thoughtLevel.trim(),
    systemPrompt: form.systemPrompt,
    tools: { allow: [...form.allow], deny: [...form.deny] },
    mcp: { playwright: form.playwright, servers },
  };

  const decoded = Schema.decodeUnknownOption(CustomAgentDefinition)(candidate);

  return Option.isSome(decoded)
    ? { errors, definition: decoded.value }
    : { errors: { form: "Check the fields." }, definition: null };
};

/** Splits typed text into tool names: commas, spaces and new lines separate them. */
export const splitTags = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

export const addTags = (list: ReadonlyArray<string>, text: string): string[] => {
  const out = [...list];

  for (const t of splitTags(text)) if (!out.includes(t)) out.push(t);

  return out;
};
