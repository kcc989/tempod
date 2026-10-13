import { DEFAULT_SETTINGS, type CredentialStatus, type Settings } from "@tempo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentMenu,
  chatTabIds,
  closedSessions,
  nextTabIndex,
  openSessionIds,
  runningTurnOf,
  sessionTitle,
  waitUntil,
} from "~/ui/components/chat/chat-tabs-model";
import { Store } from "~/ui/lib/store";
import { getWorkspaceUi, openTab, resetUiState, syncChatTabs } from "~/ui/state/workspace-ui";
import { session, turn } from "../fixtures";

const off = { set: false, updatedAt: null };
const on = { set: true, updatedAt: 1 };
const status = (over: Partial<CredentialStatus> = {}): CredentialStatus => ({
  claude: off,
  codex: { ...off, lastRefresh: null },
  openrouter: off,
  anthropic: off,
  openai: off,
  ...over,
});

afterEach(() => {
  resetUiState();
  vi.useRealTimers();
});

describe("new chat menu", () => {
  const models = (over: Partial<Settings["agent"]["models"]> = {}): Settings => ({
    ...DEFAULT_SETTINGS,
    agent: {
      ...DEFAULT_SETTINGS.agent,
      models: { claude: "", codex: "", opencode: "m/oc", pi: "m/pi", ...over },
    },
  });

  it("hides agents without a login (claude: claude or anthropic; codex: codex or openai; opencode and pi: openrouter)", () => {
    const enabled = (s: CredentialStatus) =>
      agentMenu(s, models())
        .filter((e) => e.enabled)
        .map((e) => e.agent);
    expect(enabled(status())).toEqual([]);
    expect(enabled(status({ anthropic: on }))).toEqual(["claude"]);
    expect(enabled(status({ openai: on }))).toEqual(["codex"]);
    expect(enabled(status({ openrouter: on }))).toEqual(["opencode", "pi"]);
    expect(agentMenu(status(), models())).toEqual([]);
    expect(agentMenu(status({ claude: on }), models()).map((e) => e.agent)).toEqual(["claude"]);
    expect(agentMenu(status({ codex: { ...on, lastRefresh: 1 } }), models()).map((e) => e.agent)).toEqual([
      "codex",
    ]);
  });

  it("disables OpenCode and Pi with an empty agent.models.<agent> (04, Tabs)", () => {
    const all = status({ claude: on, codex: { ...on, lastRefresh: 1 }, openrouter: on });
    const menu = agentMenu(all, models({ opencode: "" }));
    expect(menu.map((e) => [e.agent, e.enabled, e.hint])).toEqual([
      ["claude", true, null],
      ["codex", true, null],
      ["opencode", false, "Set a model in Settings → Project"],
      ["pi", true, null],
    ]);
    expect(
      agentMenu(all, DEFAULT_SETTINGS)
        .filter((e) => !e.enabled)
        .map((e) => e.agent),
    ).toEqual(["opencode", "pi"]);
    expect(agentMenu(status(), DEFAULT_SETTINGS)).toEqual([]);
  });

  it("hides agents until credential status is known", () => {
    expect(agentMenu(undefined, null)).toEqual([]);
    expect(agentMenu(undefined, DEFAULT_SETTINGS)).toEqual([]);
  });
});

describe("chat tabs", () => {
  const sessions = {
    a: session({ id: "a", sortOrder: 2 }),
    b: session({ id: "b", sortOrder: 1 }),
    c: session({ id: "c", sortOrder: 0, status: "closed" }),
    d: session({ id: "d", sortOrder: 3, status: "closed" }),
  };

  it("lists open sessions in sort order and closed ones newest first", () => {
    expect(openSessionIds(sessions)).toEqual(["b", "a"]);
    expect(closedSessions(sessions).map((s) => s.id)).toEqual(["d", "c"]);
  });

  it("keeps a closed chat the user opened to read", () => {
    const ids = chatTabIds(openSessionIds(sessions), ["c", "zz"], sessions);
    expect(ids).toEqual(["b", "a", "c"]);
    openTab("w1", { kind: "chat", sessionId: "c" });
    syncChatTabs("w1", ids);
    expect(getWorkspaceUi("w1").tabs.map((t) => t.key)).toEqual(["chat:c", "chat:b", "chat:a"]);
    syncChatTabs("w1", openSessionIds(sessions));
    expect(getWorkspaceUi("w1").tabs.map((t) => t.key)).toEqual(["chat:b", "chat:a"]);
  });

  it("titles a chat by its title, else its agent", () => {
    expect(sessionTitle(session({ title: "Fix login" }))).toBe("Fix login");
    expect(sessionTitle(session({ title: " ", agent: "codex" }))).toBe("Codex");
    expect(sessionTitle(undefined)).toBe("Chat");
  });

  it("finds the session's running turn", () => {
    const turns = { t1: turn({ id: "t1", status: "completed" }), t2: turn({ id: "t2", status: "running" }) };
    expect(runningTurnOf(turns, "s1")?.id).toBe("t2");
    expect(runningTurnOf(turns, "s2")).toBeUndefined();
  });

  it("moves focus with arrows, Home and End", () => {
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
    expect(nextTabIndex("a", 0, 3)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("waiting for a cancelled turn", () => {
  it("resolves when the store says so", async () => {
    const store = new Store({ running: true });
    const p = waitUntil(store.subscribe, () => !store.getSnapshot().running, 1000);
    store.set({ running: false });
    await expect(p).resolves.toBe(true);
  });

  it("resolves at once when already done, and false after the timeout", async () => {
    const store = new Store({ running: false });
    await expect(waitUntil(store.subscribe, () => !store.getSnapshot().running, 10)).resolves.toBe(true);
    vi.useFakeTimers();
    const busy = new Store({ running: true });
    const p = waitUntil(busy.subscribe, () => !busy.getSnapshot().running, 5000);
    vi.advanceTimersByTime(5000);
    await expect(p).resolves.toBe(false);
  });
});
