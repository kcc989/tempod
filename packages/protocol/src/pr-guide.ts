import { Schema } from "effect";

export const PR_GUIDE_PATH = ".tempo/pr-guide.json";

const Text = Schema.String.check(Schema.isBetweenLength(1, 20_000));

const Label = Schema.String.check(Schema.isBetweenLength(1, 200));

export const GuidePath = Schema.String.check(
  Schema.isBetweenLength(1, 1024),
  Schema.isPattern(
    // oxlint-disable-next-line no-control-regex
    /^(?!\/)(?!.*\\)(?!.*[\u0000-\u001f\u007f])(?!(?:.*\/)?\.{1,2}(?:\/|$))[^/]+(?:\/[^/]+)*$/,
  ),
);

export const GuideFlowNode = Schema.Struct({
  id: Label,
  label: Label,
  description: Text,
  path: Schema.optional(GuidePath),
});

export const GuideFlowEdge = Schema.Struct({ from: Label, to: Label, label: Label });

export const GuideVisual = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("comparison"), title: Label, before: Text, after: Text }),
  Schema.Struct({
    kind: Schema.Literal("flow"),
    title: Label,
    nodes: Schema.Array(GuideFlowNode).check(Schema.isBetweenLength(1, 30)),
    edges: Schema.Array(GuideFlowEdge).check(Schema.isMaxLength(60)),
  }),
  Schema.Struct({
    kind: Schema.Literals(["markdown", "image", "html"]),
    title: Label,
    path: GuidePath,
    caption: Schema.optional(Text),
  }),
]);

export type GuideVisual = typeof GuideVisual.Type;

export const GuideChapter = Schema.Struct({
  id: Label,
  title: Label,
  description: Text,
  files: Schema.Array(GuidePath).check(Schema.isMaxLength(100)),
  visuals: Schema.Array(GuideVisual).check(Schema.isMaxLength(10)),
});

export type GuideChapter = typeof GuideChapter.Type;

export const PrGuide = Schema.Struct({
  version: Schema.Literal(1),
  title: Label,
  summary: Text,
  before: Text,
  after: Text,
  chapters: Schema.Array(GuideChapter).check(Schema.isBetweenLength(1, 50)),
});

export type PrGuide = typeof PrGuide.Type;

export function parsePrGuide(content: string): PrGuide {
  const guide = Schema.decodeUnknownSync(PrGuide)(JSON.parse(content));
  const chapters = new Set<string>();

  for (const chapter of guide.chapters) {
    if (chapters.has(chapter.id)) throw new Error("Chapter ids must be unique.");
    chapters.add(chapter.id);

    for (const visual of chapter.visuals) {
      if (visual.kind !== "flow") continue;
      const ids = new Set(visual.nodes.map((n) => n.id));

      if (ids.size !== visual.nodes.length) throw new Error("Flow node ids must be unique.");

      if (visual.edges.some((e) => !ids.has(e.from) || !ids.has(e.to)))
        throw new Error("Flow edges must refer to existing nodes.");
    }
  }

  return guide;
}
