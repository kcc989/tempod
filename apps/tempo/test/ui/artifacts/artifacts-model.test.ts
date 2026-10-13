import type { Artifact, Item } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_HTML_SANDBOX,
  artifactGroups,
  artifactSrc,
  imageDataUrl,
  isFramed,
  isImagePath,
  isMarkdownPath,
  svgDataUrl,
  versionLabel,
  workspaceRelative,
} from "~/ui/components/artifacts/artifact-model";
import { buildTranscriptRows } from "~/ui/components/chat/transcript-model";
import { foldsIntoWork, planProposalText } from "~/ui/components/chat/work-model";
import { parseTabRef, tabKey, tabRef } from "~/ui/state/workspace-ui";
import { agentMessage, turn, userMessage } from "../fixtures";

/** 04 Artifacts tab, Artifact tab, file and diff images, plan proposals. */

const A = "01jart00000000000000000001";

const B = "01jart00000000000000000002";

const artifact = (id: string, version: number, createdAt: number): Artifact => ({
  id,
  version,
  sessionId: "s1",
  turnId: null,
  itemId: `i${id}${version}`,
  path: "/workspace/plan.md",
  name: "plan.md",
  title: `T${id.slice(-1)}`,
  summary: null,
  mime: "text/markdown",
  kind: "markdown",
  size: 10,
  sha256: "x",
  status: "ready",
  createdAt,
});

describe("artifact-model", () => {
  it("groups versions per artifact, newest version first, groups by newest version", () => {
    const groups = artifactGroups([artifact(A, 1, 1), artifact(B, 1, 2), artifact(A, 2, 3)]);
    expect(groups.map((g) => g.id)).toEqual([A, B]);
    expect(groups[0]!.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("labels, routes and kinds", () => {
    expect(versionLabel(1)).toBe("");
    expect(versionLabel(3)).toBe("v3");
    expect(artifactSrc("w1", A, 2)).toBe(`/api/workspaces/w1/artifacts/${A}/2`);
    expect(artifactSrc("w1", A, 2, true)).toBe(`/api/workspaces/w1/artifacts/${A}/2?download=1`);
    expect(isFramed("pdf") && isFramed("html") && !isFramed("image")).toBe(true);
    expect(ARTIFACT_HTML_SANDBOX).toBe("allow-scripts allow-forms allow-modals allow-downloads");
    expect(workspaceRelative("/workspace/docs/plan.md")).toBe("docs/plan.md");
    expect(workspaceRelative("/home/tempo/artifacts/plan.md")).toBeNull();
  });

  it("file images: raster from base64, SVG from text through a data URL; Markdown paths", () => {
    expect(isImagePath("a/b.PNG") && isImagePath("x.svg") && !isImagePath("x.txt")).toBe(true);
    expect(isMarkdownPath("README.md") && isMarkdownPath("a.markdown") && !isMarkdownPath("a.mdx")).toBe(
      true,
    );
    expect(imageDataUrl("a.png", { content: "iVBO", encoding: "base64" })).toBe("data:image/png;base64,iVBO");
    expect(imageDataUrl("a.png", { content: "text", encoding: "utf8" })).toBeNull();
    expect(imageDataUrl("a.svg", { content: "<svg/>", encoding: "utf8" })).toBe(svgDataUrl("<svg/>"));
    expect(svgDataUrl("<svg/>")).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E");
  });
});

describe("artifact tabs (workspace-ui)", () => {
  it("one tab per artifact; the ref keeps the version", () => {
    const tab = { kind: "artifact", artifactId: A, version: 2 } as const;
    expect(tabKey(tab)).toBe(`artifact:${A}`);
    expect(tabRef(tab)).toBe(`artifact:${A}:2`);
    expect(parseTabRef(`artifact:${A}:2`)).toEqual(tab);
    expect(parseTabRef(`artifact:${A}:`)).toEqual({ ...tab, version: null });
    expect(parseTabRef("artifact:nope:1")).toBeNull();
    expect(parseTabRef(`artifact:${A}:0`)).toBeNull();
  });
});

const planCall = (plan: import("@tempo/protocol").JsonData): Item => ({
  id: "tc1",
  sessionId: "s1",
  turnId: "t1",
  kind: "tool_call",
  status: "pending",
  content: { toolCallId: "call-1", title: "ExitPlanMode", locations: [], content: [], rawInput: { plan } },
  rev: 1,
  createdAt: 1100,
  updatedAt: 1100,
});

const permissionFor = (toolCallId: string): Item => ({
  id: "p1",
  sessionId: "s1",
  turnId: "t1",
  kind: "permission",
  status: "pending",
  content: { requestId: "r1", toolCallId, title: "Approve plan?", options: [] },
  rev: 1,
  createdAt: 1200,
  updatedAt: 1200,
});

const artifactItem = (): Item => ({
  id: "a1",
  sessionId: "s1",
  turnId: "t1",
  kind: "artifact",
  status: "completed",
  content: {
    artifactId: A,
    version: 1,
    title: "Plan",
    name: "plan.md",
    path: "/workspace/plan.md",
    mime: "text/markdown",
    artifactKind: "markdown",
    size: 1,
  },
  rev: 1,
  createdAt: 1150,
  updatedAt: 1150,
});

describe("plan proposals and artifact items in the transcript (04)", () => {
  it("a tool call with a non-empty rawInput.plan is a plan proposal and stays outside the work row", () => {
    expect(planProposalText(planCall("# Plan"))).toBe("# Plan");
    expect(planProposalText(planCall("  "))).toBeNull();
    expect(planProposalText(planCall(42))).toBeNull();
    expect(foldsIntoWork(planCall("# Plan"), undefined)).toBe(false);
    expect(foldsIntoWork(artifactItem(), undefined)).toBe(false);
  });

  it("the permission for the plan's tool call shows under the plan card, not as its own row", () => {
    const items = [
      userMessage("u1", "Plan it"),
      agentMessage("m0", "Reading", { createdAt: 1050 }),
      planCall("# Plan"),
      artifactItem(),
      permissionFor("call-1"),
      agentMessage("m1", "Done", { createdAt: 1300 }),
    ];

    const map = Object.fromEntries(items.map((i) => [i.id, i]));

    const rows = buildTranscriptRows(
      items.map((i) => i.id),
      map,
      { t1: turn({ status: "completed", endedAt: 2000 }) },
    );

    const itemRows = rows.filter((r) => r.kind === "item");
    expect(itemRows.map((r) => (r.kind === "item" ? r.itemId : ""))).toEqual(["u1", "tc1", "a1", "m1"]);
    expect(itemRows.find((r) => r.kind === "item" && r.itemId === "tc1")).toMatchObject({
      permissionId: "p1",
    });

    const other = buildTranscriptRows(
      ["u1", "p1"],
      { u1: items[0]!, p1: permissionFor("call-2") },
      {
        t1: turn({ status: "completed", endedAt: 2000 }),
      },
    );

    expect(other.some((r) => r.kind === "item" && r.itemId === "p1")).toBe(true);
  });
});
