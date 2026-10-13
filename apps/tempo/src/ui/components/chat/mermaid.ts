import { svgDataUrl } from "~/ui/lib/svg";

/**
 * Mermaid diagrams (04, Design and front-end rules): mermaid 12.1.0, loaded lazily, strict security
 * and no HTML labels. The SVG is shown only through `<img>`, never inline (05).
 */

type MermaidApi = typeof import("mermaid").default;

let loaded: Promise<MermaidApi> | null = null;
let theme: "dark" | "default" | null = null;
let counter = 0;
let chain: Promise<unknown> = Promise.resolve();

const load = (): Promise<MermaidApi> => {
  if (import.meta.env.SSR) return Promise.reject(new Error("Diagrams render in the browser."));
  loaded ??= import("mermaid").then((m) => m.default);
  return loaded;
};

export const MERMAID_CONFIG = { startOnLoad: false, securityLevel: "strict", htmlLabels: false } as const;

/** Renders one diagram to an `<img>` source. Renders run one at a time. */
export const renderMermaid = (code: string, dark: boolean): Promise<string> => {
  const next = chain.then(async () => {
    const mermaid = await load();
    const wanted = dark ? "dark" : "default";
    if (theme !== wanted) {
      mermaid.initialize({ ...MERMAID_CONFIG, theme: wanted });
      theme = wanted;
    }
    const { svg } = await mermaid.render(`tempo-mermaid-${++counter}`, code);
    return svgDataUrl(svg);
  });
  chain = next.catch(() => undefined);
  return next;
};
