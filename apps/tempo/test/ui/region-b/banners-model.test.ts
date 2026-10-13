import { describe, expect, it } from "vitest";
import { bannerCodes, workspaceBanners } from "~/ui/components/chat/banners-model";
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
  it("shows only the current status while starting", () => {
    const banners = workspaceBanners(detail({ state: "starting", op }));
    expect(banners).toEqual([
      {
        kind: "progress",
        title: "Cloning repo",
        setup: false,
      },
    ]);
  });

  it("offers the Setup tab while setting up", () => {
    expect(workspaceBanners(detail({ state: "setting_up", op: null }))).toEqual([
      { kind: "progress", title: "Running setup", setup: true },
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

  it("falls back to the workspace status before a step is available", () => {
    expect(workspaceBanners(detail({ state: "starting", op: null }))).toEqual([
      { kind: "progress", title: "Starting the workspace", setup: false },
    ]);
    expect(workspaceBanners(detail({ state: "creating", op: { ...op, step: "" } }))).toEqual([
      { kind: "progress", title: "Creating the workspace", setup: false },
    ]);
  });
});
