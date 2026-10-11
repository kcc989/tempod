import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMIT_REQUEST_TTL_MS,
  clearCommitRequest,
  commitRequestStore,
  isCommitRequested,
  requestCommit,
  takeCommitRequest,
} from "~/ui/components/topbar/commit-request";

describe("commit popover requests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    commitRequestStore.set({ workspaceId: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is taken once, by its own workspace", () => {
    requestCommit("w1");
    expect(isCommitRequested("w2")).toBe(false);
    expect(takeCommitRequest("w2")).toBe(false);
    expect(takeCommitRequest("w1")).toBe(true);
    expect(takeCommitRequest("w1")).toBe(false);
  });

  it("notifies subscribers", () => {
    const seen: Array<string | null> = [];
    const off = commitRequestStore.subscribe(() => seen.push(commitRequestStore.getSnapshot().workspaceId));
    requestCommit("w1");
    clearCommitRequest("w1");
    off();
    expect(seen).toEqual(["w1", null]);
  });

  it("expires when nobody takes it", () => {
    requestCommit("w1");
    vi.advanceTimersByTime(COMMIT_REQUEST_TTL_MS - 1);
    expect(isCommitRequested("w1")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isCommitRequested("w1")).toBe(false);
  });

  it("a newer request replaces an older one", () => {
    requestCommit("w1");
    requestCommit("w2");
    expect(isCommitRequested("w1")).toBe(false);
    vi.advanceTimersByTime(COMMIT_REQUEST_TTL_MS);
    expect(isCommitRequested("w2")).toBe(false);
  });

  it("clearing another workspace's request does nothing", () => {
    requestCommit("w1");
    clearCommitRequest("w2");
    expect(isCommitRequested("w1")).toBe(true);
  });
});
