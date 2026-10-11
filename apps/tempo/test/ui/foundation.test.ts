import { TempoError } from "@tempo/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorage, removeLocalStorage } from "./storage-stub";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

const {
  errorCode,
  errorText,
  isBannerShown,
  onUnauthenticated,
  showBanner,
  toastError: showToast,
} = await import("~/ui/lib/toast");
const { readThemePreference, resolveTheme, setThemePreference, themeStore, THEME_BOOT_SCRIPT } =
  await import("~/ui/lib/theme");
const { firstRunSteps, isFirstRunDone } = await import("~/ui/lib/first-run");
const { githubBranchUrl, macWorkspaceUrl, workspacePath } = await import("~/ui/lib/links");

const creds = (
  set: Partial<Record<"claude" | "codex" | "openrouter" | "anthropic" | "openai", boolean>>,
) => ({
  claude: { set: set.claude ?? false, updatedAt: null },
  codex: { set: set.codex ?? false, updatedAt: null, lastRefresh: null },
  openrouter: { set: set.openrouter ?? false, updatedAt: null },
  anthropic: { set: set.anthropic ?? false, updatedAt: null },
  openai: { set: set.openai ?? false, updatedAt: null },
});

beforeEach(() => {
  toastError.mockClear();
});

describe("toastError", () => {
  it("shows the error-table message", () => {
    expect(showToast(new TempoError("NOTHING_TO_COMMIT"))).toBe(true);
    expect(toastError).toHaveBeenCalledWith("Nothing to commit.", { id: "error:NOTHING_TO_COMMIT" });
  });

  it("keeps the server's agent-specific message", () => {
    const e = new TempoError("CREDENTIAL_MISSING", "Add your Codex login in Settings.");
    expect(errorText(e)).toBe("Add your Codex login in Settings.");
  });

  it("maps unknown errors to INTERNAL", () => {
    expect(errorCode(new TypeError("fetch failed"))).toBe("INTERNAL");
    expect(errorText(new TypeError("fetch failed"))).toBe("Something went wrong.");
    expect(errorText({ code: "PR_EXISTS", message: "A pull request already exists." })).toBe(
      "A pull request already exists.",
    );
  });

  it("skips codes a banner shows, and caller-skipped codes", () => {
    const off = showBanner(["CREDENTIAL_INVALID"]);
    const off2 = showBanner(["CREDENTIAL_INVALID"]);
    expect(showToast(new TempoError("CREDENTIAL_INVALID"))).toBe(false);
    off();
    expect(isBannerShown("CREDENTIAL_INVALID")).toBe(true);
    off2();
    off2();
    expect(isBannerShown("CREDENTIAL_INVALID")).toBe(false);
    expect(showToast(new TempoError("SETUP_FAILED"), { skip: ["SETUP_FAILED"] })).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("sends UNAUTHENTICATED to the sign-in listener instead of a toast", () => {
    const listener = vi.fn();
    const off = onUnauthenticated(listener);
    expect(showToast(new TempoError("UNAUTHENTICATED"))).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    expect(showToast(new TempoError("UNAUTHENTICATED"))).toBe(true);
  });
});

describe("theme", () => {
  beforeEach(() => installLocalStorage());
  afterEach(() => removeLocalStorage());

  it("follows the system unless light or dark is chosen", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("keeps the preference per browser", () => {
    expect(readThemePreference()).toBe("system");
    setThemePreference("dark");
    expect(readThemePreference()).toBe("dark");
    expect(themeStore.getSnapshot()).toEqual({ preference: "dark", resolved: "dark" });
    expect(globalThis.localStorage.getItem("tempo:theme")).toBe("dark");
    setThemePreference("system");
    expect(globalThis.localStorage.getItem("tempo:theme")).toBeNull();
  });

  it("boot script reads the same key", () => {
    expect(THEME_BOOT_SCRIPT).toContain('localStorage.getItem("tempo:theme")');
  });

  it("survives blocked storage", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    expect(readThemePreference()).toBe("system");
    expect(() => setThemePreference("light")).not.toThrow();
  });
});

describe("first run", () => {
  const base = {
    configured: true,
    installationCount: 1,
    credentials: creds({ claude: true }),
    projectCount: 1,
    workspaceCount: 1,
  };

  it("is done when all five steps are", () => {
    const steps = firstRunSteps(base);
    expect(steps.map((s) => s.id)).toEqual([
      "createApp",
      "installApp",
      "addLogin",
      "linkRepo",
      "createWorkspace",
    ]);
    expect(isFirstRunDone(steps)).toBe(true);
  });

  it("marks each missing step", () => {
    const steps = firstRunSteps({ ...base, installationCount: 0, credentials: creds({}), workspaceCount: 0 });
    expect(steps.filter((s) => !s.done).map((s) => s.id)).toEqual([
      "installApp",
      "addLogin",
      "createWorkspace",
    ]);
    expect(isFirstRunDone(steps)).toBe(false);
  });

  it("counts any login that lets an agent run", () => {
    for (const k of ["claude", "codex", "openrouter", "anthropic", "openai"] as const) {
      expect(firstRunSteps({ ...base, credentials: creds({ [k]: true }) })[2]!.done).toBe(true);
    }
    expect(firstRunSteps({ ...base, credentials: undefined })[2]!.done).toBe(false);
  });
});

describe("links", () => {
  it("builds app, Mac and GitHub URLs", () => {
    expect(workspacePath("01h")).toBe("/w/01h");
    expect(macWorkspaceUrl("01h")).toBe("tempo://workspace/01h");
    expect(githubBranchUrl("acme", "app", "tempo/lisbon")).toBe(
      "https://github.com/acme/app/tree/tempo/lisbon",
    );
  });
});
