// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TempoError } from "@tempo/protocol";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserTab } from "../../../src/ui/components/review/BrowserTab";
import { OverflowMenu } from "../../../src/ui/components/topbar/OverflowMenu";
import { PortLinks } from "../../../src/ui/components/topbar/PortLinks";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";
import { call } from "../../../src/ui/lib/api";
import { getWorkspaceUi, resetUiState } from "../../../src/ui/state/workspace-ui";
import { detail } from "../fixtures";

vi.mock("~/ui/lib/api", () => ({ call: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const WS = "01jaxk3v2m9q8r7t6y5w4e3d2c";
const BARE = `https://3000-${WS}.previews.test`;
const link = (code: string) => `${BARE}/__tempo/enter?code=${code}`;

const fakeTab = () => ({ opener: {} as unknown, location: { href: "" }, close: vi.fn() });

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const wrap = (node: ReactNode) =>
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, node),
    ),
  );

beforeEach(() => {
  vi.mocked(call).mockReset();
  resetUiState();
});

describe("port links (04, Top bar middle)", () => {
  const show = () =>
    wrap(
      createElement(PortLinks, { workspaceId: WS, ports: [{ port: 3000, url: BARE }], browserActive: false }),
    );

  it("opens the tab on the click, then sends it to the link from openPreview", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
    const pending = deferred<{ url: string }>();
    vi.mocked(call).mockReturnValue(pending.promise as never);
    show();
    const a = screen.getByRole("link", { name: "3000 ↗" });
    // The bare URL holds no secret, so it can show as the link target.
    expect(a.getAttribute("href")).toBe(BARE);
    fireEvent.click(a);
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    expect(call).toHaveBeenCalledWith("openPreview", { workspaceId: WS, port: 3000 });
    expect(tab.location.href).toBe("");
    await act(async () => pending.resolve({ url: link("a".repeat(32)) }));
    expect(tab.location.href).toBe(link("a".repeat(32)));
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("closes the tab and shows the error toast when openPreview fails", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as never);
    vi.mocked(call).mockRejectedValue(new TempoError("NOT_FOUND"));
    show();
    fireEvent.click(screen.getByRole("link", { name: "3000 ↗" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.href).toBe("");
    expect(toast.error).toHaveBeenCalledWith("Not found.", { id: "error:NOT_FOUND" });
  });

  it("opens a middle click the same way", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as never);
    vi.mocked(call).mockResolvedValue({ url: link("b".repeat(32)) } as never);
    show();
    fireEvent(
      screen.getByRole("link", { name: "3000 ↗" }),
      new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
    );
    await waitFor(() => expect(tab.location.href).toBe(link("b".repeat(32))));
  });

  it("⌥-click opens a Browser tab for the bare preview URL and opens no browser tab", () => {
    const open = vi.spyOn(window, "open");
    show();
    fireEvent.click(screen.getByRole("link", { name: "3000 ↗" }), { altKey: true });
    expect(open).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(getWorkspaceUi(WS).tabs.map((t) => t.tab)).toEqual([{ kind: "browser", url: BARE }]);
  });
});

describe("overflow menu on a phone (04, Overflow menu, Phone width)", () => {
  const actions = {
    wake: vi.fn(),
    sleep: vi.fn(),
    archive: vi.fn(),
    copyLink: vi.fn(),
    resetPreviewAccess: vi.fn(),
    pending: { power: false, archive: false },
  };
  const show = () => {
    vi.mocked(call).mockImplementation(async (name) => {
      if (name === "listProjects") return [] as never;
      if (name === "openPreview") return { url: link("c".repeat(32)) } as never;
      throw new Error(`unexpected ${name}`);
    });
    const d = detail({ id: WS, ports: [{ port: 3000, url: BARE }] });
    wrap(createElement(OverflowMenu, { view: { w: d, d }, actions: actions as never, phone: true }));
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
  };

  it("lists Reset preview access and calls the confirmed action", async () => {
    show();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset preview access" }));
    expect(actions.resetPreviewAccess).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Rotate preview link")).toBeNull();
  });

  it("opens a preview link the same way as the top bar", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
    show();
    fireEvent.click(await screen.findByRole("menuitem", { name: "3000 ↗" }));
    expect(open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(tab.location.href).toBe(link("c".repeat(32))));
    expect(call).toHaveBeenCalledWith("openPreview", { workspaceId: WS, port: 3000 });
  });
});

describe("preview Browser tab (04, Browser tabs)", () => {
  const show = (url = BARE) =>
    wrap(
      createElement(BrowserTab, {
        workspaceId: WS,
        tab: { kind: "browser", url },
        active: true,
        seq: 1,
      }),
    );
  const frame = () => screen.queryByTitle("Preview") as HTMLIFrameElement | null;

  it("loads the entry link from openPreview and never shows the code in the address bar", async () => {
    vi.mocked(call).mockResolvedValue({ url: link("d".repeat(32)) } as never);
    show();
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(link("d".repeat(32))));
    expect(call).toHaveBeenCalledWith("openPreview", { workspaceId: WS, port: 3000 });
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe(`${BARE}/`);
  });

  it("asks for a new link on Reload, because a link works once", async () => {
    vi.mocked(call)
      .mockResolvedValueOnce({ url: link("e".repeat(32)) } as never)
      .mockResolvedValueOnce({ url: link("f".repeat(32)) } as never);
    show();
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(link("e".repeat(32))));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(link("f".repeat(32))));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("goes to a typed path on the preview's own origin", async () => {
    vi.mocked(call).mockResolvedValue({ url: link("g".repeat(32)) } as never);
    show();
    await waitFor(() => expect(frame()).not.toBeNull());
    const input = screen.getByLabelText("Address");
    fireEvent.change(input, { target: { value: "/about" } });
    fireEvent.submit(input.closest("form")!);
    expect(frame()?.getAttribute("src")).toBe(`${BARE}/about`);
  });

  it("shows the error instead of the page when openPreview fails", async () => {
    vi.mocked(call).mockRejectedValue(new TempoError("NOT_FOUND"));
    show();
    expect(await screen.findByText("Not found.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("opens a new browser tab through openPreview", async () => {
    vi.mocked(call).mockResolvedValue({ url: link("h".repeat(32)) } as never);
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
    show();
    await waitFor(() => expect(frame()).not.toBeNull());
    fireEvent.click(screen.getByRole("link", { name: "Open in a new tab" }));
    expect(open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(tab.location.href).toBe(link("h".repeat(32))));
  });

  it("loads any other address directly", () => {
    show("https://example.com/");
    expect(call).not.toHaveBeenCalled();
    expect(frame()?.getAttribute("src")).toBe("https://example.com/");
  });
});
