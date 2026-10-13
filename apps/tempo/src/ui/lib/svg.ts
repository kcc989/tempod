/** SVG renders only through `<img>` (05); a data URL keeps it out of the document. */
export const svgDataUrl = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
