import { parsePrGuide, type GuideChapter, type PrGuide } from "@tempo/protocol";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { MessageMarkdown } from "~/ui/components/chat/Markdown";
import { Button } from "~/ui/components/ui/button";
import { cn } from "~/ui/lib/utils";
import { Comparison, GuideVisual, guideMarkdownId, type GuideSource } from "./GuideVisual";

export function decodeGuideFile(file: {
  readonly content: string;
  readonly encoding: "utf8" | "base64";
}): { readonly guide: PrGuide } | { readonly error: true } {
  try {
    if (file.encoding !== "utf8") return { error: true };

    return { guide: parsePrGuide(file.content) };
  } catch {
    return { error: true };
  }
}

export function GuideChapters({
  guide,
  source,
  nav,
  code,
  className,
}: {
  guide: PrGuide;
  source: GuideSource;
  nav?: ReactNode;
  code: (chapter: GuideChapter, scrollRoot: RefObject<HTMLDivElement | null>) => ReactNode;
  className?: string;
}) {
  const workspaceId = guideMarkdownId(source);
  const [selectedId, setSelectedId] = useState(guide.chapters[0]!.id);
  const scrollRoot = useRef<HTMLDivElement>(null);

  const index = Math.max(
    0,
    guide.chapters.findIndex((c) => c.id === selectedId),
  );

  const chapter = guide.chapters[index]!;

  const select = (id: string) => {
    setSelectedId(id);

    if (scrollRoot.current) scrollRoot.current.scrollTop = 0;
  };

  return (
    <div className={cn("flex min-h-0 flex-col overflow-auto md:flex-row md:overflow-hidden", className)}>
      <nav
        aria-label="Guide chapters"
        className="shrink-0 space-y-1 border-b p-2 md:w-56 md:overflow-y-auto md:border-r md:border-b-0"
      >
        <h2 className="px-2 py-2 text-sm font-semibold">{guide.title}</h2>
        {guide.chapters.map((c, i) => (
          <Button
            key={c.id}
            variant={c.id === chapter.id ? "secondary" : "ghost"}
            size="sm"
            className="h-auto w-full justify-start py-2 text-left whitespace-normal"
            aria-current={c.id === chapter.id ? "step" : undefined}
            onClick={() => select(c.id)}
          >
            <span className="mr-1 text-muted-foreground">{i + 1}.</span>
            {c.title}
          </Button>
        ))}
        {nav}
      </nav>
      <div
        ref={scrollRoot}
        className="min-w-0 flex-1 space-y-4 p-3 md:overflow-y-auto"
        aria-label="Guided review"
      >
        <details open={index === 0} key={`overview-${chapter.id}`} className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">PR overview</summary>
          <div className="mt-3 space-y-3">
            <MessageMarkdown workspaceId={workspaceId} text={guide.summary} streaming={false} />
            <Comparison workspaceId={workspaceId} before={guide.before} after={guide.after} />
          </div>
        </details>
        <article key={chapter.id} className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold">{chapter.title}</h3>
            <span className="shrink-0 text-xs text-muted-foreground">
              {index + 1} / {guide.chapters.length}
            </span>
          </div>
          <MessageMarkdown workspaceId={workspaceId} text={chapter.description} streaming={false} />
          {chapter.visuals.map((v, i) => (
            <GuideVisual key={`${i}-${JSON.stringify(v)}`} source={source} visual={v} />
          ))}
          {code(chapter, scrollRoot)}
          {chapter.files.length === 0 && (
            <p className="text-xs text-muted-foreground">This chapter has no linked code files.</p>
          )}
        </article>
        <div className="flex justify-between border-t pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={index === 0}
            onClick={() => select(guide.chapters[index - 1]!.id)}
          >
            <ChevronLeftIcon />
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={index === guide.chapters.length - 1}
            onClick={() => select(guide.chapters[index + 1]!.id)}
          >
            Next
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
