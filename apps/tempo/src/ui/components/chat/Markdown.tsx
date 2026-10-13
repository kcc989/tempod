import { Schema } from "effect";
import { CheckIcon, CopyIcon } from "lucide-react";
import { createContext, memo, useContext, useEffect, useState } from "react";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "~/ui/components/ui/button";
import { useTheme } from "~/ui/hooks/useTheme";
import { cn } from "~/ui/lib/utils";
import { openFile } from "~/ui/state/workspace-ui";
import { highlight, type HighlightLines } from "./highlight";
import { DiagramRendererContext } from "./mermaid";
import { fileLinkTarget } from "./transcript-model";

interface MarkdownEnv {
  readonly workspaceId: string;
  /** True while the message streams: code is not highlighted yet. */
  readonly streaming: boolean;
}

type Element = NonNullable<ExtraProps["node"]>;

type ElementContent = Element["children"][number];

const Env = createContext<MarkdownEnv>({ workspaceId: "", streaming: false });

const textOf = (node: ElementContent | Element): string =>
  node.type === "text" ? node.value : "children" in node ? node.children.map(textOf).join("") : "";

const languageOf = (code: Element | undefined): string => {
  const cls = code?.properties?.["className"];
  const list: string[] = Array.isArray(cls) ? cls.map(String) : String(cls ?? "").split(" ");

  return list.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
};

const isWeb = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

/** Keeps workspace file links so they can open a file tab; everything else as react-markdown does. */
const urlTransform = (url: string): string =>
  url.startsWith("file:///workspace/") ? (fileLinkTarget(url) ? url : "") : defaultUrlTransform(url);

function MarkdownLink({ href, children }: { href?: string | undefined; children?: React.ReactNode }) {
  const { workspaceId } = useContext(Env);
  const target = href ? fileLinkTarget(href) : null;

  if (target) {
    return (
      <button
        type="button"
        className="cursor-pointer text-primary underline underline-offset-2"
        onClick={() => openFile(workspaceId, target.path, target.line)}
      >
        {children}
      </button>
    );
  }

  if (!href) return <span>{children}</span>;

  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** 05: remote images in agent Markdown are not loaded; they show as links. */
function MarkdownImage({ src, alt }: { src?: string | Blob | undefined; alt?: string | undefined }) {
  const url = Schema.is(Schema.String)(src) ? src : undefined;
  const label = alt?.trim() || url || "Image";

  if (!isWeb(url)) return <span className="text-muted-foreground">{label}</span>;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

const components: Components = {
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  pre: ({ node }) => {
    const code = node?.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
    const text = code ? textOf(code) : node ? textOf(node) : "";
    const lang = languageOf(code);

    if (lang === "mermaid") return <MermaidBlock code={text.replace(/\n$/, "")} />;

    return <CodeBlock code={text.replace(/\n$/, "")} lang={lang} />;
  },
};

const plugins = [remarkGfm];

/** GitHub-flavoured Markdown without raw HTML (react-markdown shows raw HTML as text). */
export const MessageMarkdown = memo(function MessageMarkdown({
  workspaceId,
  text,
  streaming,
}: {
  workspaceId: string;
  text: string;
  streaming: boolean;
}) {
  return (
    <Env.Provider value={{ workspaceId, streaming }}>
      <div className="prose-tempo max-w-[75ch] text-sm">
        <Markdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
          {text}
        </Markdown>
      </div>
    </Env.Provider>
  );
});

/**
 * A `mermaid` code block as a diagram, shown through `<img>`. While the message streams it stays a
 * code block; when rendering fails the code block stays with a note under it (04).
 */
export function MermaidBlock({ code }: { code: string }) {
  const renderMermaid = useContext(DiagramRendererContext);
  const { streaming } = useContext(Env);
  const dark = useTheme().resolved === "dark";
  const [result, setResult] = useState<{ key: string; src: string | null } | null>(null);
  const key = `${dark ? "d" : "l"}:${code}`;
  useEffect(() => {
    if (streaming) return;
    let live = true;
    renderMermaid(code, dark).then(
      (src) => live && setResult({ key, src }),
      () => live && setResult({ key, src: null }),
    );

    return () => {
      live = false;
    };
  }, [code, dark, key, streaming, renderMermaid]);
  const current = result?.key === key ? result : null;

  if (current?.src)
    return (
      <div className="my-2 overflow-x-auto rounded-md border bg-background p-2">
        <img src={current.src} alt="Diagram" className="max-w-full" />
      </div>
    );

  return (
    <>
      <CodeBlock code={code} lang="mermaid" />
      {current && current.src === null && (
        <p className="-mt-1 mb-2 text-xs text-destructive">Diagram failed to render.</p>
      )}
    </>
  );
}

/** A code block with lazy Shiki highlighting and a copy button. */
export function CodeBlock({ code, lang, className }: { code: string; lang: string; className?: string }) {
  const { streaming } = useContext(Env);
  const [result, setResult] = useState<{ code: string; lang: string; lines: HighlightLines } | null>(null);
  useEffect(() => {
    if (streaming || !lang) return;
    let live = true;
    highlight(code, lang)
      .then((lines) => {
        if (live && lines) setResult({ code, lang, lines });
      })
      .catch(() => {
        // Plain text stays.
      });

    return () => {
      live = false;
    };
  }, [code, lang, streaming]);
  const lines = result && result.code === code && result.lang === lang ? result.lines : null;

  return (
    <div className={cn("group/code relative my-2 rounded-md border bg-muted/40", className)}>
      <div className="flex h-6 items-center justify-between border-b px-2 text-xs text-muted-foreground">
        <span>{lang || "text"}</span>
        <CopyButton text={code} />
      </div>
      <pre data-shiki="" className="overflow-x-auto p-2 font-mono text-xs leading-5">
        <code>
          {lines
            ? lines.map((line, i) => (
                <span key={i} className="block min-h-5">
                  {line.map((t, j) => (
                    <span key={j} style={t.style}>
                      {t.content}
                    </span>
                  ))}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}

export function CopyButton({ text, label = "Copy code" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);

    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="size-5"
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
    </Button>
  );
}
