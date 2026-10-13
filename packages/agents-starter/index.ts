import { Schema } from "effect";
import { AgentDefinition } from "@tempo/protocol";

export const STARTERS: readonly AgentDefinition[] = [
  Schema.decodeUnknownSync(AgentDefinition)({
    handle: "planner",
    name: "Planner",
    outputKind: "plan",
    access: "read-only",
    description: "Plans the requested change and reports a concrete implementation plan.",
    prompt:
      "Read the request and the repository. Describe a concrete implementation plan, including the files to change and how to verify the change. Report the plan as steps with report_result. Use status done when the plan is complete.",
  }),
  Schema.decodeUnknownSync(AgentDefinition)({
    handle: "reviewer",
    name: "Reviewer",
    outputKind: "review",
    access: "read-only",
    description: "Reviews the branch diff against the plan and reports blocking issues.",
    prompt:
      "Review the diff against the plan. Report each problem as a finding. Mark a finding blocking when the change must not merge with it. Set status pass when no finding is blocking, else fail.",
  }),
  Schema.decodeUnknownSync(AgentDefinition)({
    handle: "check-fixer",
    name: "Check fixer",
    outputKind: "note",
    access: "write",
    description: "Checks the branch diff and fixes verification failures.",
    prompt:
      "Review the diff and run checks. Fix verification failures in workspace files and verify the fixes. Report a summary with report_result. Use done when verification succeeds or blocked when checks cannot run or a fix needs the owner's help.",
  }),
];
