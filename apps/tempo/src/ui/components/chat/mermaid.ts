import { createContext } from "react";
import { svgDataUrl } from "~/ui/lib/svg";

type MermaidApi = typeof import("mermaid").default;

interface DiagramApi {
  initialize(config: Parameters<MermaidApi["initialize"]>[0]): void;
  render(id: string, code: string): Promise<{ svg: string }>;
}

export const MERMAID_CONFIG = { startOnLoad: false, securityLevel: "strict", htmlLabels: false } as const;

/** Lazy diagram engine boundary; each renderer serializes its requests and owns its theme state. */
export const createMermaidRenderer = (loader: () => Promise<DiagramApi>) => {
  let loaded: Promise<DiagramApi> | null = null;
  let theme: "dark" | "default" | null = null;
  let counter = 0;
  let chain: Promise<void> = Promise.resolve();

  return (code: string, dark: boolean): Promise<string> => {
    const next = chain.then(async () => {
      if (import.meta.env.SSR) throw new Error("Diagrams render in the browser.");
      loaded ??= loader();
      const engine = await loaded;
      const wanted = dark ? "dark" : "default";

      if (theme !== wanted) {
        engine.initialize({ ...MERMAID_CONFIG, theme: wanted });
        theme = wanted;
      }

      const { svg } = await engine.render(`tempo-mermaid-${++counter}`, code);

      return svgDataUrl(svg);
    });

    chain = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  };
};

/** Mermaid stays out of SSR; strict, non-HTML diagrams are displayed as image data URLs. */
export const renderMermaid = createMermaidRenderer(() => import("mermaid").then((module) => module.default));

export const DiagramRendererContext = createContext(renderMermaid);
