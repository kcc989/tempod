import { describe, expect, it } from "vitest";
import { bannerCodes, stepRows, workspaceBanners } from "~/ui/components/chat/banners-model";
import { detail } from "../fixtures";

const op = {
  kind: "wake" as const,
  status: "running" as const,
  step: "repo.clone",
  steps: [
    { name: "container.start", status: "done" as const, ms: 4000 },
    { name: "repo.clone", status: "running" as const, ms: null },
    { name: "settings.read", status: "pending" as const, ms: null },
  ],
};

describe("workspace banners", () => {
  it("shows the op's steps with their times while starting", () => {
    const banners = workspaceBanners(detail({ state: "starting", op }));
    expect(banners).toEqual([
      {
        kind: "progress",
        title: "Starting the workspace",
        setup: false,
        steps: [
          { key: "0:container.start", label: "Starting container", status: "done", time: "4 s" },
          { key: "1:repo.clone", label: "Cloning repo", status: "running", time: null },
          { key: "2:settings.read", label: "Reading settings", status: "pending", time: null },
        ],
      },
    ]);
  });

  it("offers the Setup tab while setting up", () => {
    expect(workspaceBanners(detail({ state: "setting_up", op: null }))).toEqual([
      { kind: "progress", title: "Running setup", setup: true, steps: [] },
    ]);
  });

  it("shows error and setup failed; no banner while sleeping (the pill wakes)", () => {
    expect(workspaceBanners(detail({ state: "sleeping" }))).toEqual([]);
    expect(
      workspaceBanners(detail({ state: "error", errorCode: "CONTAINER_START_FAILED", errorDetail: "boom" })),
    ).toEqual([
      {
        kind: "error",
        code: "CONTAINER_START_FAILED",
        message: "The container did not start. Retry.",
        detail: "boom",
      },
    ]);
    expect(workspaceBanners(detail({ state: "error", errorCode: "NOPE" }))[0]).toMatchObject({
      code: "INTERNAL",
      message: "Something went wrong.",
    });
    expect(workspaceBanners(detail({ state: "ready", setupStatus: "failed" }))).toEqual([
      { kind: "setupFailed" },
    ]);
    expect(workspaceBanners(detail({ state: "sleeping", setupStatus: "failed" })).map((b) => b.kind)).toEqual(
      ["setupFailed"],
    );
  });

  it("shows nothing for a ready workspace or a failed setup once archived", () => {
    expect(workspaceBanners(detail({ state: "ready" }))).toEqual([]);
    expect(workspaceBanners(detail({ state: "archived", setupStatus: "failed" }))).toEqual([]);
  });

  it("names the codes the banners show so toasts skip them", () => {
    const banners = workspaceBanners(
      detail({ state: "error", errorCode: "CLONE_FAILED", setupStatus: "failed" }),
    );
    expect(bannerCodes(banners)).toEqual(["CLONE_FAILED"]);
    expect(bannerCodes(workspaceBanners(detail({ setupStatus: "failed" })))).toEqual(["SETUP_FAILED"]);
  });

  it("formats failed step times too", () => {
    expect(stepRows({ ...op, steps: [{ name: "x.y", status: "failed", ms: 61_000 }] })[0]).toEqual({
      key: "0:x.y",
      label: "X y",
      status: "failed",
      time: "1 min 1 s",
    });
  });
});
