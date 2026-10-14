import { browserTabs } from "../../../src/ui/components/topbar/open-preview";
import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { elementOrNull } from "../elements.ts";
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TempoError } from "@tempo/protocol";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CenterTabPart } from "../../../src/ui/components/chat/tab-kinds";
import { LiveViewTab } from "../../../src/ui/components/review/LiveViewTab";
import { PortLinks } from "../../../src/ui/components/topbar/PortLinks";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";

import { getWorkspaceUi, resetUiState } from "../../../src/ui/state/workspace-ui";
import { emptyWorkspaceState } from "../../../src/ui/stores/workspace-state";
import { detail } from "../fixtures";

const WS = "01jaxk3v2m9q8r7t6y5w4e3d2c";

const BARE = `https://3000-${WS}.previews.test`;

const live = (jwt: string) => `https://live.browser.test/devtools/inspector.html?wss=x&jwt=${jwt}`;

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
  environment.setState({ ...emptyWorkspaceState, ready: true, workspace: detail({ id: WS, browserActive }) });
};

const liveCalls = () => vi.mocked(call).mock.calls.filter(([name]) => name === "getBrowserLiveView");

beforeEach(() => {
  vi.spyOn(toast, "error").mockImplementation(() => 0);
  vi.spyOn(toast, "success").mockImplementation(() => 0);
  vi.mocked(call).mockReset();
  resetUiState();
  setActive(true);
  localStorage.clear();
  sessionStorage.clear();
});

describe("Live in the top bar (04, Top bar middle)", () => {
  const show = (browserActive: boolean, ports = [{ port: 3000, url: BARE }]) =>
    render(tree(createElement(PortLinks, { workspaceId: WS, ports, browserActive })), {
      wrapper: environment.Provider,
    });

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
    const open = vi.spyOn(browserTabs, "open");
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

  const frame = () => elementOrNull(screen.queryByTitle("Live View"), HTMLIFrameElement);

  it("is titled Browser in the tool tab bar", () => {
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
      { wrapper: environment.Provider },
    );
    expect(screen.getByText("Browser")).toBeTruthy();
  });

  it("asks getBrowserLiveView for a link when it opens and shows it in an iframe", async () => {
    vi.mocked(call).mockResolvedValue({ url: live("a") });
    render(element(), { wrapper: environment.Provider });
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("a")));
    expect(call).toHaveBeenCalledWith("getBrowserLiveView", { workspaceId: WS });
    expect(frame()?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame()?.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(frame()?.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame()?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("asks for a new link on Reload", async () => {
    vi.mocked(call)
      .mockResolvedValueOnce({ url: live("a") })
      .mockResolvedValueOnce({ url: live("b") });
    render(element(), { wrapper: environment.Provider });
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("a")));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(frame()).toBeNull();
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("b")));
    expect(liveCalls()).toHaveLength(2);
  });

  it("asks again when the tab is opened again", async () => {
    vi.mocked(call)
      .mockResolvedValueOnce({ url: live("a") })
      .mockResolvedValueOnce({ url: live("b") });
    const { rerender } = render(element(1), { wrapper: environment.Provider });
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("a")));
    rerender(element(2));
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe(live("b")));
    expect(liveCalls()).toHaveLength(2);
  });

  it("shows Browser session ended. when no session is open", async () => {
    vi.mocked(call).mockResolvedValue({ url: null });
    render(element(), { wrapper: environment.Provider });
    expect(await screen.findByText("Browser session ended.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("drops the page and shows Browser session ended. when browserActive turns false", async () => {
    vi.mocked(call).mockResolvedValue({ url: live("a") });
    const { rerender } = render(element(), { wrapper: environment.Provider });
    await waitFor(() => expect(frame()).not.toBeNull());
    setActive(false);
    rerender(element());
    expect(screen.getByText("Browser session ended.")).toBeTruthy();
    expect(frame()).toBeNull();
    expect(document.body.innerHTML).not.toContain(live("a"));
  });

  it("does not show a link that arrives after the session ended", async () => {
    const pending = deferred<{ url: string | null }>();
    vi.mocked(call).mockReturnValue(pending.promise);
    const { rerender } = render(element(), { wrapper: environment.Provider });
    setActive(false);
    rerender(element());
    await act(async () => pending.resolve({ url: live("late") }));
    expect(screen.getByText("Browser session ended.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("stays on Browser session ended. while browserActive is false, on open and on Reload", async () => {
    vi.mocked(call).mockResolvedValue({ url: live("stale") });
    setActive(false);
    render(element(), { wrapper: environment.Provider });
    expect(screen.getByText("Browser session ended.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(liveCalls()).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByText("Browser session ended.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("shows the error text when getBrowserLiveView fails", async () => {
    vi.mocked(call).mockRejectedValue(new TempoError("NOT_FOUND"));
    render(element(), { wrapper: environment.Provider });
    expect(await screen.findByText("Not found.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("never puts the link in browser storage or the tab state", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    vi.mocked(call).mockResolvedValue({ url: live("secret") });
    render(
      tree(
        createElement(PortLinks, {
          workspaceId: WS,
          ports: [{ port: 3000, url: BARE }],
          browserActive: true,
        }),
      ),
      { wrapper: environment.Provider },
    );
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    render(element(), { wrapper: environment.Provider });
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
