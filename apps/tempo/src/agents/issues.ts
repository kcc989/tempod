import { lifecycleRedactor } from "./secrets.ts";
import {
  AgentProfile,
  ISSUE_TOOLS,
  IssueToolName,
  MAX_MESSAGE_BYTES,
  TempoError,
  type RepositoryIssue,
  type RepositoryIssueComment,
  type ToolReq,
} from "@tempo/protocol";
import { Schema } from "effect";
import { eq } from "drizzle-orm";
import { user } from "../db/d1.ts";
import { d1 } from "../server/handlers/common.ts";
import * as handlers from "../server/handlers/issues.ts";
import type { WorkspaceCore } from "../do/workspace/core.ts";

const matches = (pattern: string, name: string): boolean => {
  const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);

  return [name, `tempo.${name}`, `mcp__tempo__${name}`, `mcp:tempo:${name}`].some((alias) =>
    expression.test(alias),
  );
};

/**
 * The session, run and profile rules shared by the project tools (08 issue tools, 12 deploy tools).
 * Returns the owner's handler context and the workspace row.
 */
export const authorizeProjectTool = async (
  core: WorkspaceCore,
  request: ToolReq,
  name: string,
  mutates: boolean,
  readOnlyDetail: string,
) => {
  const session = core.sessionRow(request.sessionId);

  if (session.status === "closed") throw new TempoError("RUN_NOT_RUNNING");

  if (session.runId) {
    if (request.runId !== session.runId) throw new TempoError("RUN_NOT_RUNNING");
    const run = core.lifecycle.runs.row(session.runId);

    if (run.status !== "running" || run.sessionId !== session.id) throw new TempoError("RUN_NOT_RUNNING");

    if (mutates && run.access !== "write") throw new TempoError("FORBIDDEN", undefined, readOnlyDetail);
  } else if (request.runId) throw new TempoError("RUN_NOT_RUNNING");

  if (session.profileJson) {
    const profile = Schema.decodeUnknownSync(Schema.fromJsonString(AgentProfile))(session.profileJson);

    if (
      profile.toolsDeny.some((pattern) => matches(pattern, name)) ||
      (profile.toolsAllow.length > 0 && !profile.toolsAllow.some((pattern) => matches(pattern, name)))
    )
      throw new TempoError("FORBIDDEN", undefined, "This tool is disabled by the session profile.");
  }

  const ws = core.ws();
  const owner = await d1(core.env).select().from(user).where(eq(user.id, ws.userId)).get();

  if (!owner) throw new TempoError("NOT_FOUND");

  return { ctx: { env: core.env, user: owner }, ws };
};

const json = (
  value:
    | Schema.Json
    | RepositoryIssue
    | RepositoryIssueComment
    | ReadonlyArray<RepositoryIssue>
    | ReadonlyArray<RepositoryIssueComment>,
) => Schema.decodeUnknownSync(Schema.Json)(value);

const page = (items: ReadonlyArray<RepositoryIssue | RepositoryIssueComment>, offset = 0): Schema.Json => {
  const bounded: Array<RepositoryIssue | RepositoryIssueComment> = [];
  let bytes = 0;

  for (const item of items) {
    const size = new TextEncoder().encode(JSON.stringify(item)).length + 1;

    if (bytes + size > MAX_MESSAGE_BYTES - 1024) break;
    bounded.push(item);
    bytes += size;
  }

  return Schema.decodeUnknownSync(Schema.Json)({
    items: bounded,
    nextOffset: bounded.length < items.length || items.length === 50 ? offset + bounded.length : null,
  });
};

export const issueTool = async (core: WorkspaceCore, request: ToolReq): Promise<Schema.Json> => {
  try {
    if (!Schema.is(IssueToolName)(request.op)) throw new TempoError("UNKNOWN_OP");
    const name = request.op;

    const { ctx, ws } = await authorizeProjectTool(
      core,
      request,
      name,
      ISSUE_TOOLS[name].mutates,
      "Read-only runs cannot change issue metadata.",
    );

    let params = request.params;

    if (ISSUE_TOOLS[name].mutates) {
      const mask = await lifecycleRedactor(core);
      const redacted = { ...Schema.decodeUnknownSync(Schema.JsonObject)(params) };

      for (const key of ["title", "body"]) {
        const text = redacted[key];

        if (Schema.is(Schema.String)(text)) redacted[key] = mask(text);
      }

      params = redacted;
    }

    const projectId = ws.projectId;

    switch (name) {
      case "list_issues": {
        const input = Schema.decodeUnknownSync(ISSUE_TOOLS.list_issues.input, { onExcessProperty: "error" })(
          params,
        );

        return page(await handlers.listRepositoryIssues(ctx, { projectId, ...input }), input.offset);
      }

      case "get_issue":
        return json(
          await handlers.getRepositoryIssue(ctx, {
            projectId,
            ...Schema.decodeUnknownSync(ISSUE_TOOLS.get_issue.input, { onExcessProperty: "error" })(params),
          }),
        );
      case "create_issue":
        return json(
          await handlers.createRepositoryIssue(ctx, {
            projectId,
            ...Schema.decodeUnknownSync(ISSUE_TOOLS.create_issue.input, { onExcessProperty: "error" })(
              params,
            ),
          }),
        );
      case "update_issue":
        return json(
          await handlers.updateRepositoryIssue(ctx, {
            projectId,
            ...Schema.decodeUnknownSync(ISSUE_TOOLS.update_issue.input, { onExcessProperty: "error" })(
              params,
            ),
          }),
        );
      case "delete_issue":
        return json(
          await handlers.deleteRepositoryIssue(ctx, {
            projectId,
            ...Schema.decodeUnknownSync(ISSUE_TOOLS.delete_issue.input, { onExcessProperty: "error" })(
              params,
            ),
          }),
        );
      case "list_issue_comments": {
        const input = Schema.decodeUnknownSync(ISSUE_TOOLS.list_issue_comments.input, {
          onExcessProperty: "error",
        })(params);

        return page(await handlers.listRepositoryIssueComments(ctx, { projectId, ...input }), input.offset);
      }

      case "comment_on_issue":
        return json(
          await handlers.createRepositoryIssueComment(ctx, {
            projectId,
            ...Schema.decodeUnknownSync(ISSUE_TOOLS.comment_on_issue.input, { onExcessProperty: "error" })(
              params,
            ),
          }),
        );
      case "update_issue_comment":
        return json(
          await handlers.updateRepositoryIssueComment(ctx, {
            projectId,
            ...Schema.decodeUnknownSync(ISSUE_TOOLS.update_issue_comment.input, {
              onExcessProperty: "error",
            })(params),
          }),
        );
      case "delete_issue_comment":
        return json(
          await handlers.deleteRepositoryIssueComment(ctx, {
            projectId,
            ...Schema.decodeUnknownSync(ISSUE_TOOLS.delete_issue_comment.input, {
              onExcessProperty: "error",
            })(params),
          }),
        );
      case "list_issue_labels":
        return json(
          await handlers.listRepositoryLabels(ctx, {
            projectId,
            ...Schema.decodeUnknownSync(ISSUE_TOOLS.list_issue_labels.input, { onExcessProperty: "error" })(
              params,
            ),
          }),
        );
    }
  } catch (cause) {
    if (cause instanceof TempoError) throw cause;

    if (Schema.isSchemaError(cause))
      throw new TempoError("VALIDATION_FAILED", undefined, "Invalid issue tool input or session profile.");
    throw new TempoError("INTERNAL", undefined, "Issue tool failed.");
  }
};
