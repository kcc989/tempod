import { afterEach, describe, expect, it, vi } from "vitest";
import { availableActions, hasAction, registerAction, resetActions, runAction } from "~/ui/state/actions";
import { isPlainCombo, matchAction, bindingFor } from "~/ui/lib/shortcuts";

afterEach(() => resetActions());

const ev = (code: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe("action registry", () => {
  it("runs the most recent registration and falls back when it unregisters", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    registerAction("newWorkspace", outer);
    const off = registerAction("newWorkspace", inner);
    expect(runAction("newWorkspace")).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    off();
    runAction("newWorkspace");
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("a fallback runs only when nothing else handles the action, whatever the order", () => {
    const specific = vi.fn();
    const fallback = vi.fn();
    const off = registerAction("newWorkspace", specific);
    const offFallback = registerAction("newWorkspace", fallback, { fallback: true });
    runAction("newWorkspace");
    expect(specific).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    off();
    runAction("newWorkspace");
    expect(fallback).toHaveBeenCalledTimes(1);
    offFallback();
    expect(runAction("newWorkspace")).toBe(false);
  });

  it("reports unhandled and disabled actions", () => {
    expect(runAction("merge")).toBe(false);
    registerAction("merge", () => undefined, { enabled: () => false });
    expect(hasAction("merge")).toBe(false);
    expect(runAction("merge")).toBe(false);
  });

  it("lists available global actions in table order", () => {
    registerAction("settings", () => undefined);
    registerAction("palette", () => undefined);
    registerAction("send", () => undefined);
    expect(availableActions().map((b) => b.id)).toEqual(["palette", "settings"]);
  });
});

describe("matchAction", () => {
  it("matches only the given ids, with exact modifiers", () => {
    expect(matchAction(ev("KeyJ"), ["nextFile", "prevFile"], true)).toBe("nextFile");
    expect(matchAction(ev("KeyK"), ["nextFile", "prevFile"], true)).toBe("prevFile");
    expect(matchAction(ev("KeyJ", { shift: true }), ["nextFile"], true)).toBeUndefined();
    expect(matchAction(ev("KeyJ", { alt: true }), ["nextFile"], true)).toBeUndefined();
    expect(matchAction(ev("KeyJ", { alt: true }), ["nextFile", "toggleBottom"], true)).toBe("toggleBottom");
  });

  it("skips plain keys in text fields unless allowed", () => {
    expect(matchAction(ev("KeyJ"), ["nextFile"], true, { editable: true })).toBeUndefined();
    expect(matchAction(ev("KeyJ"), ["nextFile"], true, { editable: true, allowPlainInEditable: true })).toBe("nextFile");
    expect(matchAction(ev("KeyU", { meta: true }), ["attach"], true, { editable: true })).toBe("attach");
    expect(matchAction(ev("KeyU", { ctrl: true }), ["attach"], false, { editable: true })).toBe("attach");
  });

  it("treats ⇧ alone as plain", () => {
    expect(isPlainCombo(bindingFor("togglePlan").key)).toBe(true);
    expect(isPlainCombo(bindingFor("expandAll").key)).toBe(false);
  });
});
