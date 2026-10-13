import { fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { useShortcuts } from "../../../src/ui/hooks/useShortcuts";

it("does not run a diff shortcut behind a modal", () => {
  const mark = vi.fn();

  function DiffKeys() {
    useShortcuts({ markViewed: mark });

    return createElement("button", null, "Diff");
  }

  const view = render(createElement(DiffKeys));
  fireEvent.keyDown(window, { code: "KeyV", ctrlKey: true });
  expect(mark).toHaveBeenCalledTimes(1);
  const modal = document.createElement("div");
  modal.dataset.slot = "dialog-content";
  modal.dataset.state = "open";
  document.body.appendChild(modal);
  fireEvent.keyDown(window, { code: "KeyV", ctrlKey: true });
  expect(mark).toHaveBeenCalledTimes(1);
  modal.remove();
  view.unmount();
});
