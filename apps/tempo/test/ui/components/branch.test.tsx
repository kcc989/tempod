import { elementOf } from "../elements.ts";
import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditableBranch } from "../../../src/ui/components/topbar/EditableBranch.tsx";
import { detail } from "../fixtures.ts";

describe("branch editor", () => {
  it("saves double-click edits on Enter or blur and cancels on Escape", () => {
    const onSave = vi.fn();
    const w = detail({ branch: "tempo/otter" });
    render(createElement(EditableBranch, { view: { w, d: w }, onSave }));
    fireEvent.click(screen.getByRole("button", { name: "Rename branch" }));
    expect(screen.queryByRole("textbox", { name: "Branch name" })).toBeNull();
    fireEvent.doubleClick(screen.getByRole("button", { name: "Rename branch" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Branch name" }), {
      target: { value: "feature/my-name" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("feature/my-name");
    fireEvent.doubleClick(screen.getByRole("button", { name: "Rename branch" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature/cancelled" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Rename branch" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature/on-blur" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onSave).toHaveBeenLastCalledWith("feature/on-blur");
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it.each([
    { pushed: true },
    { state: "archived" as const },
    { state: "archiving" as const },
    { state: "starting" as const },
    { state: "setting_up" as const },
  ])("locks branch editing for %s", (overrides) => {
    const w = detail(overrides);
    render(createElement(EditableBranch, { view: { w, d: w }, onSave: vi.fn() }));
    expect(elementOf(screen.getByRole("button", { name: "Rename branch" }), HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
