import { describe, expect, it } from "vitest";
import { attachmentUrl, rememberAttachment, thumbnailSrc } from "~/ui/components/chat/attachment-cache";

describe("transcript attachment thumbnails", () => {
  it("prefers this browser's upload, then the owner-only route for inline image types", () => {
    expect(attachmentUrl("w1", "a/1")).toBe("/api/workspaces/w1/attachments/a%2F1");
    expect(thumbnailSrc("w1", { id: "a1", mime: "image/png" })).toBe("/api/workspaces/w1/attachments/a1");
    rememberAttachment("a2", "blob:local");
    expect(thumbnailSrc("w1", { id: "a2", mime: "image/png" })).toBe("blob:local");
  });

  it("does not load types the route serves as downloads", () => {
    expect(thumbnailSrc("w1", { id: "a3", mime: "image/svg+xml" })).toBeUndefined();
    expect(thumbnailSrc("w1", { id: "a4", mime: "image/bmp" })).toBeUndefined();
    expect(thumbnailSrc("w1", { id: "a5", mime: "application/pdf" })).toBeUndefined();
  });
});
