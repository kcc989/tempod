import { detail } from "../fixtures";
import { resetUiState } from "../../../src/ui/state/workspace-ui";
import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { elementOf } from "../elements.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TempoError } from "@tempo/protocol";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilesView } from "../../../src/ui/components/review/FilesView";
import { FileTab } from "../../../src/ui/components/review/FileTab";

beforeEach(() => {
  resetUiState();
  environment.setState({ workspace: detail({ state: "sleeping" }) });
});

const show = (child: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(createElement(QueryClientProvider, { client }, child), { wrapper: environment.Provider });
};

describe("browsing sleeping files", () => {
  it("shows cached paths and leaves the file picker available without waking", async () => {
    vi.mocked(call).mockResolvedValue({ paths: ["README.md"] });
    show(createElement(FilesView, { workspaceId: "w1" }));
    await screen.findByRole("tree");
    expect(screen.getByText("README.md")).toBeDefined();
    expect(screen.getByText("Last synced files. May be out of date.")).toBeDefined();
    expect(elementOf(screen.getByRole("button", { name: /Open file/ }), HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(elementOf(screen.getByRole("button", { name: /Search/ }), HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(call).mock.calls.every(([name]) => name === "listFiles")).toBe(true);
  });

  it("shows cached file contents with a freshness notice", async () => {
    vi.mocked(call).mockResolvedValue({ content: "saved contents", encoding: "utf8", size: 14 });
    show(
      createElement(FileTab, {
        workspaceId: "w1",
        active: true,
        tab: { kind: "file", path: "README.md", line: null },
        seq: 1,
      }),
    );
    await screen.findByText("saved contents");
    expect(screen.getByText("Last synced file. May be out of date.")).toBeDefined();
    expect(vi.mocked(call).mock.calls.every(([name]) => name === "readFile")).toBe(true);
  });

  it("offers a wake on a cache miss and sends it only after clicking", async () => {
    vi.mocked(call).mockRejectedValue(new TempoError("CONTAINER_NOT_READY"));
    show(
      createElement(FileTab, {
        workspaceId: "w1",
        active: true,
        tab: { kind: "file", path: "missing.ts", line: null },
        seq: 1,
      }),
    );
    const button = await screen.findByRole("button", { name: "Wake to browse files" });
    expect(vi.mocked(call).mock.calls.every(([name]) => name === "readFile")).toBe(true);
    vi.mocked(call).mockResolvedValue({});
    fireEvent.click(button);
    await waitFor(() => expect(call).toHaveBeenCalledWith("wakeWorkspace", { workspaceId: "w1" }));
  });
});
