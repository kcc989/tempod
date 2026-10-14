import { Schema } from "effect";
import { RepositoryIssue, RepositoryIssueComment } from "./types.ts";
import { API, type FnName } from "./api.ts";

export const ISSUE_TOOL_NAMES = [
  "list_issues",
  "get_issue",
  "create_issue",
  "update_issue",
  "delete_issue",
  "list_issue_comments",
  "comment_on_issue",
  "update_issue_comment",
  "delete_issue_comment",
  "list_issue_labels",
] as const;

export const IssueToolName = Schema.Literals(ISSUE_TOOL_NAMES);

export type IssueToolName = typeof IssueToolName.Type;

const projectInput = <F extends Schema.Struct.Fields & { readonly projectId: typeof Schema.String }>(
  schema: Schema.Struct<F>,
) => {
  const { projectId: _projectId, ...fields } = schema.fields;

  return Schema.Struct(fields);
};

export const ISSUE_TOOLS = {
  list_issues: {
    fn: "listRepositoryIssues",
    mutates: false,
    input: projectInput(API.listRepositoryIssues.input),
    description:
      "List issues in this workspace's Tempo repository. Filter by state, text or label; pages contain up to 50 issues.",
  },
  get_issue: {
    fn: "getRepositoryIssue",
    mutates: false,
    input: projectInput(API.getRepositoryIssue.input),
    description: "Read an issue in this workspace's Tempo repository by its number.",
  },
  create_issue: {
    fn: "createRepositoryIssue",
    mutates: true,
    input: projectInput(API.createRepositoryIssue.input),
    description:
      "Create an issue in this workspace's Tempo repository. Optional labelIds assign existing project labels. Requires a writable run or interactive chat.",
  },
  update_issue: {
    fn: "updateRepositoryIssue",
    mutates: true,
    input: projectInput(API.updateRepositoryIssue.input),
    description:
      "Edit an issue's title, body, state or labels. Set state to open or closed; omitted fields retain their values. Requires a writable run or interactive chat.",
  },
  delete_issue: {
    fn: "deleteRepositoryIssue",
    mutates: true,
    input: projectInput(API.deleteRepositoryIssue.input),
    description:
      "Permanently delete an issue and its comments from this workspace's Tempo repository. Use only when instructed to delete it; closing preserves discussion. Requires a writable run or interactive chat.",
  },
  list_issue_comments: {
    fn: "listRepositoryIssueComments",
    mutates: false,
    input: projectInput(API.listRepositoryIssueComments.input),
    description: "Read an issue's comments in chronological pages of up to 50.",
  },
  comment_on_issue: {
    fn: "createRepositoryIssueComment",
    mutates: true,
    input: projectInput(API.createRepositoryIssueComment.input),
    description:
      "Add a comment to an open or closed issue in this workspace's Tempo repository. Requires a writable run or interactive chat.",
  },
  update_issue_comment: {
    fn: "updateRepositoryIssueComment",
    mutates: true,
    input: projectInput(API.updateRepositoryIssueComment.input),
    description:
      "Edit a comment belonging to the given issue in this workspace's Tempo repository. Requires a writable run or interactive chat.",
  },
  delete_issue_comment: {
    fn: "deleteRepositoryIssueComment",
    mutates: true,
    input: projectInput(API.deleteRepositoryIssueComment.input),
    description:
      "Delete a comment belonging to the given issue in this workspace's Tempo repository. Requires a writable run or interactive chat.",
  },
  list_issue_labels: {
    fn: "listRepositoryLabels",
    mutates: false,
    input: projectInput(API.listRepositoryLabels.input),
    description: "List this workspace's repository labels and their IDs for filtering and assigning issues.",
  },
} satisfies Record<IssueToolName, { fn: FnName; mutates: boolean; input: Schema.Top; description: string }>;

export const IssueToolPage = Schema.Struct({
  items: Schema.Array(RepositoryIssue),
  nextOffset: Schema.NullOr(Schema.Number),
});

export const IssueCommentToolPage = Schema.Struct({
  items: Schema.Array(RepositoryIssueComment),
  nextOffset: Schema.NullOr(Schema.Number),
});
