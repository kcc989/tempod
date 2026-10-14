import type { ConfigOption } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  applyInsertions,
  canSend,
  chipLabel,
  configPickers,
  contextUsage,
  currentValueLabel,
  draftKey,
  isDraft,
  MAX_ATTACHMENT_BYTES,
  mentionTrigger,
  moveIndex,
  optionGroups,
  replaceTrigger,
  reviewChipLabel,
  slashEntries,
  slashTrigger,
  splitBySize,
} from "~/ui/components/chat/composer-model";
import { session } from "../fixtures";

const model: ConfigOption = {
  id: "model",
  name: "Model",
  type: "select",
  category: "model",
  currentValue: "sonnet",
  options: [
    { value: "default", name: "Default" },
    {
      group: "anthropic",
      name: "Anthropic",
      options: [
        { value: "sonnet", name: "Sonnet" },
        { value: "opus", name: "Opus" },
      ],
    },
  ],
};

const effort: ConfigOption = {
  id: "effort",
  name: "Effort",
  type: "select",
  category: "thought_level",
  currentValue: "high",
  options: [{ value: "high", name: "High" }],
};

const fast: ConfigOption = { id: "fast", name: "Fast mode", type: "boolean", currentValue: false };

const modeOption: ConfigOption = {
  id: "mode",
  name: "Mode",
  type: "select",
  category: "mode",
  currentValue: "build",
  options: [{ value: "build", name: "Build" }],
};

describe("drafts", () => {
  it("keeps one draft per workspace and session", () => {
    expect(draftKey("w1", "s1")).toBe("composer:draft:w1:s1");
    expect(draftKey("w1", "s1")).not.toBe(draftKey("w1", "s2"));
    expect(isDraft("x")).toBe(true);
    expect(isDraft(3)).toBe(false);
  });
});

describe("attachments", () => {
  it("rejects files over 10 MiB", () => {
    const { ok, tooLarge } = splitBySize([
      { name: "a", size: 1 },
      { name: "b", size: MAX_ATTACHMENT_BYTES },
      { name: "c", size: MAX_ATTACHMENT_BYTES + 1 },
    ]);

    expect(ok.map((f) => f.name)).toEqual(["a", "b"]);
    expect(tooLarge.map((f) => f.name)).toEqual(["c"]);
  });
});

describe("@ and / triggers", () => {
  it("finds an @ mention at the caret", () => {
    expect(mentionTrigger("look at @src/ma", 15)).toEqual({ start: 8, query: "src/ma" });
    expect(mentionTrigger("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionTrigger("mail me@host", 12)).toBeNull();
    expect(mentionTrigger("@a b", 4)).toBeNull();
  });
  it("finds a / command only at the start", () => {
    expect(slashTrigger("/pl", 3)).toEqual({ start: 0, query: "pl" });
    expect(slashTrigger("/plan now", 9)).toBeNull();
    expect(slashTrigger("a /plan", 7)).toBeNull();
    expect(slashTrigger("/usr/bin", 8)).toBeNull();
  });
  it("replaces the trigger text and moves the caret", () => {
    const text = "see @sr please";
    const t = mentionTrigger(text, 7)!;
    expect(replaceTrigger(text, 7, t, "")).toEqual({ text: "see  please", caret: 4 });
    expect(replaceTrigger("/re", 3, { start: 0, query: "re" }, "/review ")).toEqual({
      text: "/review ",
      caret: 8,
    });
  });
  it("lists the agent's commands plus Tempo's /plan", () => {
    const commands = [
      { name: "review", description: "Review the diff" },
      { name: "compact", description: null },
    ];

    expect(slashEntries(commands, true, "").map((e) => e.key)).toEqual([
      "tempo:plan",
      "agent:review",
      "agent:compact",
    ]);
    expect(slashEntries(commands, false, "").map((e) => e.key)).toEqual(["agent:review", "agent:compact"]);
    expect(slashEntries(commands, true, "rev").map((e) => e.name)).toEqual(["review"]);
    expect(slashEntries(commands, true, "")[0]).toMatchObject({
      description: "Toggle plan mode",
      kind: "plan",
    });
  });
});

describe("insertions", () => {
  it("adds mention chips once, merges review comments and appends text", () => {
    const next = applyInsertions({ text: "hi", mentions: [{ path: "a.ts" }], reviewCommentIds: ["c1"] }, [
      { id: 1, sessionId: "s1", insertion: { kind: "mention", path: "a.ts" } },
      { id: 2, sessionId: null, insertion: { kind: "mention", path: "b.ts" } },
      { id: 3, sessionId: "s1", insertion: { kind: "reviewComments", commentIds: ["c1", "c2"] } },
      { id: 4, sessionId: "s1", insertion: { kind: "text", text: "there" } },
    ]);

    expect(next).toEqual({
      text: "hi there",
      mentions: [{ path: "a.ts" }, { path: "b.ts" }],
      reviewCommentIds: ["c1", "c2"],
    });
    expect(
      applyInsertions({ text: "", mentions: [], reviewCommentIds: [] }, [
        { id: 5, sessionId: null, insertion: { kind: "text", text: "x" } },
      ]).text,
    ).toBe("x");
  });
  it("labels the review-comment chip", () => {
    expect(reviewChipLabel(1)).toBe("1 review comment");
    expect(reviewChipLabel(3)).toBe("3 review comments");
  });
});

describe("sending", () => {
  it("sends text, attachments or review comments, not while uploading", () => {
    const base = { text: "", attachmentCount: 0, reviewCommentCount: 0, uploading: false };
    expect(canSend(base)).toBe(false);
    expect(canSend({ ...base, text: "  " })).toBe(false);
    expect(canSend({ ...base, text: "go" })).toBe(true);
    expect(canSend({ ...base, attachmentCount: 1 })).toBe(true);
    expect(canSend({ ...base, reviewCommentCount: 2 })).toBe(true);
    expect(canSend({ ...base, text: "go", uploading: true })).toBe(false);
  });
  it("labels queued chips with the first line", () => {
    expect(chipLabel("\n  fix the build\nthen test")).toBe("fix the build");
    expect(chipLabel("x".repeat(60), 10)).toBe(`${"x".repeat(9)}…`);
    expect(chipLabel("")).toBe("Empty message");
  });
  it("moves a queued chip within bounds", () => {
    expect(moveIndex(3, 0, -1)).toBe(0);
    expect(moveIndex(3, 0, 1)).toBe(1);
    expect(moveIndex(3, 2, 1)).toBe(2);
  });
});

describe("pickers and usage", () => {
  it("reads used and total context from usage_update", () => {
    expect(contextUsage({ used: 50_000, size: 200_000 })).toEqual({
      used: 50_000,
      size: 200_000,
      ratio: 0.25,
    });
    expect(contextUsage({ used: 300, size: 200 })?.ratio).toBe(1);
    expect(contextUsage({})).toBeNull();
    expect(contextUsage({ used: 1, size: 0 })).toBeNull();
  });
  it("splits config options into the model, reasoning level and mode pickers, and the rest", () => {
    const s = session({ configOptions: [model, effort, fast, modeOption] });
    const p = configPickers(s);
    expect(p.model?.id).toBe("model");
    expect(p.thoughtLevel?.id).toBe("effort");
    expect(p.modeOption?.id).toBe("mode");
    expect(p.others.map((o) => o.id)).toEqual(["fast"]);
    expect(configPickers(session({ configOptions: [model] })).thoughtLevel).toBeUndefined();

    const withModes = configPickers(
      session({ configOptions: [modeOption], modes: [{ id: "plan", name: "Plan" }] }),
    );

    expect(withModes.modeOption).toBeUndefined();
    expect(withModes.others).toEqual([]);
  });
  it("names the current value and keeps the agent's groups", () => {
    expect(currentValueLabel(model)).toBe("Sonnet");
    expect(currentValueLabel(fast)).toBe("Off");
    expect(currentValueLabel({ ...model, currentValue: "unknown" })).toBe("unknown");
    expect(optionGroups(model)).toEqual([
      { name: null, values: [{ value: "default", name: "Default" }] },
      {
        name: "Anthropic",
        values: [
          { value: "sonnet", name: "Sonnet" },
          { value: "opus", name: "Opus" },
        ],
      },
    ]);
  });
});
