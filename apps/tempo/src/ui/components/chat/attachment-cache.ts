/**
 * Thumbnails of images uploaded from this browser, by attachment id. Other images load from the
 * owner-only attachment route (02); other files show as a name chip.
 */
const previews = new Map<string, string>();
const MAX = 64;
const uploads = new Map<string, string | undefined>();

export const startAttachmentUpload = (id: string, preview?: string): void => {
  uploads.set(id, preview);
};
export const finishAttachmentUpload = (id: string): void => {
  uploads.delete(id);
};
export const isAttachmentUploading = (id: string): boolean => uploads.has(id);
export const uploadPreview = (id: string): string | undefined => uploads.get(id);

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

/** The image types the attachment route serves inline (02). */
export const isServedInline = (mime: string): boolean => /^image\/(png|jpeg|gif|webp)$/i.test(mime);

export const attachmentUrl = (workspaceId: string, attachmentId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(attachmentId)}`;

/** Where a transcript thumbnail comes from: this browser's upload, else the server, else none. */
export const thumbnailSrc = (
  workspaceId: string,
  attachment: { readonly id: string; readonly mime: string },
): string | undefined =>
  attachmentPreview(attachment.id) ??
  (isServedInline(attachment.mime) ? attachmentUrl(workspaceId, attachment.id) : undefined);
