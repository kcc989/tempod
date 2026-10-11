/**
 * Thumbnails of images uploaded from this browser, by attachment id. The server has no route to
 * read an attachment back, so other attachments show as a name chip.
 */
const previews = new Map<string, string>();
const MAX = 64;

export const isPreviewable = (mime: string): boolean => /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(mime);

/** Takes ownership of an object URL made for the composer chip. */
export const rememberAttachment = (attachmentId: string, objectUrl: string): void => {
  previews.set(attachmentId, objectUrl);
  while (previews.size > MAX) {
    const [oldest, url] = previews.entries().next().value!;
    previews.delete(oldest);
    URL.revokeObjectURL(url);
  }
};

export const attachmentPreview = (attachmentId: string): string | undefined => previews.get(attachmentId);
