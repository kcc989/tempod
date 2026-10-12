// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TempoError } from "@tempo/protocol";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CenterTabPart } from "../../../src/ui/components/chat/tab-kinds";
import { LiveViewTab } from "../../../src/ui/components/review/LiveViewTab";
import { OverflowMenu } from "../../../src/ui/components/topbar/OverflowMenu";
import { PortLinks } from "../../../src/ui/components/topbar/PortLinks";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";
import { call } from "../../../src/ui/lib/api";
import { getWorkspaceUi, resetUiState } from "../../../src/ui/state/workspace-ui";
import { emptyWorkspaceState } from "../../../src/ui/stores/workspace-state";
import { detail } from "../fixtures";

const fixture = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("~/ui/hooks/useWorkspace", () => ({
  useWorkspaceSelector: (_: string, select: (state: unknown) => unknown) => select(fixture.state),
}));
vi.mock("~/ui/lib/api", () => ({ call: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const WS = "01jaxk3v2m9q8r7t6y5w4e3d2c";
const BARE = `https://3000-${WS}.previews.test`;
const live = (jwt: string) => `https://live.browser.test/devtools/inspector.html?wss=x&jwt=${jwt}`;

const fakeTab = () => ({ opener: {} as unknown, location: { href: "" }, close: vi.fn() });

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const tree = (node: ReactNode) =>
  createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    createElement(TooltipProvider, null, node),
  );

const setActive = (browserActive: boolean) => {
  fixture.state = { ...emptyWorkspaceState, ready: true, workspace: detail({ id: WS, browserActive }) };
};

const liveCalls = () => vi.mocked(call).mock.calls.filter(([name]) => name === "getBrowserLiveView");

beforeEach(() => {
  vi.mocked(call).mockReset();
  resetUiState();
  setActive(true);
  localStorage.clear();
  sessionStorage.clear();
});

describe("Live in the top bar (04, Top bar middle)", () => {
  const show = (browserActive: boolean, ports = [{ port: 3000, url: BARE }]) =>
    render(tree(createElement(PortLinks, { workspaceId: WS, ports, browserActive })));

  it("shows Live after the port links only while a Browser Run session is open", () => {
    const { unmount } = show(false);
    expect(screen.queryByRole("button", { name: "Live" })).toBeNull();
    unmount();
    show(true);
    const nav = screen.getByRole("navigation", { name: "Previews" });
    expect([...nav.querySelectorAll("a, button")].map((e) => e.textContent)).toEqual(["3000 ↗", "Live"]);
  });

  it("shows Live with no ports, and nothing when there are neither", () => {
    const { unmount } = show(false, []);
    expect(screen.queryByRole("navigation", { name: "Previews" })).toBeNull();
    unmount();
    show(true, []);
    expect(screen.getByRole("button", { name: "Live" })).toBeTruthy();
  });

  it("opens the Live View tab on a click, with no browser tab and no call", () => {
    const open = vi.spyOn(window, "open");
    show(true);
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(open).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(getWorkspaceUi(WS).tabs.map((t) => t.tab)).toEqual([{ kind: "liveView" }]);
    expect(getWorkspaceUi(WS).activeKey).toBe("liveView");
  });
});

describe("Live View tab (04, Browser tabs)", () => {
  const element = (seq = 1) =>
    tree(createElement(LiveViewTab, { workspaceId: WS, tab: { kind: "liveView" }, active: true, seq }));
  const frame = () => screen.queryByTitle("Live View") as HTMLIFrameElement | null;

  it("is titled Live View in the tab bar", () => {
    render(
      tree(
        createElement(CenterTabPart, {
          part: "Title",
          workspaceId: WS,
          tab: { kind: "liveView" },
          active: true,
          seq: 1,
        }),
      ),
    );
    expect(screen.getByText("Live View")).toBeTruthy();
  });

  it("asks getBrowserLiveView for a link when it opens and shows it in an iframe", async () => {
    vi.mocked(call).mockResolvedValue({ url: live("a") } as never);
    render(element());
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("a")));
    expect(call).toHaveBeenCalledWith("getBrowserLiveView", { workspaceId: WS });
    expect(frame()?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame()?.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(frame()?.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame()?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("asks for a new link on Reload", async () => {
    vi.mocked(call)
      .mockResolvedValueOnce({ url: live("a") } as never)
      .mockResolvedValueOnce({ url: live("b") } as never);
    render(element());
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("a")));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(frame()).toBeNull();
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("b")));
    expect(liveCalls()).toHaveLength(2);
  });

  it("asks again when the tab is opened again", async () => {
    vi.mocked(call)
      .mockResolvedValueOnce({ url: live("a") } as never)
      .mockResolvedValueOnce({ url: live("b") } as never);
    const { rerender } = render(element(1));
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("a")));
    rerender(element(2));
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("b")));
    expect(liveCalls()).toHaveLength(2);
  });

  it("shows Browser session ended. when no session is open", async () => {
    vi.mocked(call).mockResolvedValue({ url: null } as never);
    render(element());
    expect(await screen.findByText("Browser session ended.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("drops the page and shows Browser session ended. when browserActive turns false", async () => {
    vi.mocked(call).mockResolvedValue({ url: live("a") } as never);
    const { rerender } = render(element());
    await waitFor(() => expect(frame()).not.toBeNull());
    setActive(false);
    rerender(element());
    expect(screen.getByText("Browser session ended.")).toBeTruthy();
    expect(frame()).toBeNull();
    expect(document.body.innerHTML).not.toContain(live("a"));
  });

  it("does not show a link that arrives after the session ended", async () => {
    const pending = deferred<{ url: string | null }>();
    vi.mocked(call).mockReturnValue(pending.promise as never);
    const { rerender } = render(element());
    setActive(false);
    rerender(element());
    await act(async () => pending.resolve({ url: live("late") }));
    expect(screen.getByText("Browser session ended.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("stays on Browser session ended. while browserActive is false, on open and on Reload", async () => {
    vi.mocked(call).mockResolvedValue({ url: live("stale") } as never);
    setActive(false);
    render(element());
    expect(screen.getByText("Browser session ended.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(liveCalls()).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByText("Browser session ended.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("shows the error text when getBrowserLiveView fails", async () => {
    vi.mocked(call).mockRejectedValue(new TempoError("NOT_FOUND"));
    render(element());
    expect(await screen.findByText("Not found.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("never puts the link in browser storage or the tab state", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    vi.mocked(call).mockResolvedValue({ url: live("secret") } as never);
    render(
      tree(
        createElement(PortLinks, {
          workspaceId: WS,
          ports: [{ port: 3000, url: BARE }],
          browserActive: true,
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    render(element());
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("secret")));
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        expect(store.getItem(store.key(i)!) ?? "").not.toContain("secret");
      }
    }
    for (const [, value] of setItem.mock.calls) expect(value).not.toContain("secret");
    expect(JSON.stringify(getWorkspaceUi(WS))).not.toContain("secret");
  });
});

describe("Live on a phone (04, Phone width)", () => {
  const actions = {
    wake: vi.fn(),
    sleep: vi.fn(),
    archive: vi.fn(),
    copyLink: vi.fn(),
    resetPreviewAccess: vi.fn(),
    pending: { power: false, archive: false },
  };
  const show = (browserActive: boolean, result: () => Promise<unknown>) => {
    vi.mocked(call).mockImplementation(async (name) => {
      if (name === "listProjects") return [] as never;
      if (name === "getBrowserLiveView") return (await result()) as never;
      throw new Error(`unexpected ${name}`);
    });
    const d = detail({ id: WS, browserActive });
    render(tree(createElement(OverflowMenu, { view: { w: d, d }, actions: actions as never, phone: true })));
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
  };

  it("lists Live only while a Browser Run session is open", async () => {
    show(false, async () => ({ url: null }));
    expect(await screen.findByRole("menuitem", { name: "Diagnostics" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Live" })).toBeNull();
  });

  it("opens a browser tab on the click, then sends it to the Live View link", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
    const pending = deferred<{ url: string | null }>();
    show(true, () => pending.promise);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Live" }));
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    expect(call).toHaveBeenCalledWith("getBrowserLiveView", { workspaceId: WS });
    await act(async () => pending.resolve({ url: live("c") }));
    expect(tab.location.href).toBe(live("c"));
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("closes the tab and says Browser session ended. when no session is open", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as never);
    show(true, async () => ({ url: null }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Live" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.href).toBe("");
    expect(toast).toHaveBeenCalledWith("Browser session ended.");
  });

  it("closes the tab and shows the error toast when the call fails", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as never);
    show(true, async () => {
      throw new TempoError("NOT_FOUND");
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Live" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith("Not found.", { id: "error:NOT_FOUND" });
  });
});
