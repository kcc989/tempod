import type { ITheme } from "@xterm/xterm";

/**
 * xterm needs concrete colours, so the theme tokens are resolved at run time. A 1×1 canvas turns
 * any CSS colour (oklch included) into rgba.
 */
let ctx: CanvasRenderingContext2D | null | undefined;

const toRgba = (css: string, alpha?: number): string | undefined => {
  if (!css) return undefined;
  ctx ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });

  if (!ctx) return undefined;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "rgba(0, 0, 0, 0)";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;

  if (a === 0) return undefined;

  return `rgba(${r}, ${g}, ${b}, ${alpha ?? (a ?? 255) / 255})`;
};

const token = (style: CSSStyleDeclaration, name: string, alpha?: number): string | undefined =>
  toRgba(style.getPropertyValue(name).trim(), alpha);

export const terminalTheme = (): ITheme => {
  const style = getComputedStyle(document.documentElement);

  const theme: ITheme = {
    background: token(style, "--background"),
    foreground: token(style, "--foreground"),
    cursor: token(style, "--foreground"),
    cursorAccent: token(style, "--background"),
    selectionBackground: token(style, "--primary", 0.3),
    red: token(style, "--destructive"),
    green: token(style, "--success"),
    yellow: token(style, "--warning"),
    blue: token(style, "--primary"),
    magenta: token(style, "--merged"),
  };

  return Object.fromEntries(Object.entries(theme).filter(([, v]) => v !== undefined));
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export const terminalFont = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || MONO;
