import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommandDialog, CommandInput } from "../../../src/ui/components/ui/command";

function SearchDialog() {
  const [open, setOpen] = useState(true);

  return createElement(
    CommandDialog,
    { open, onOpenChange: setOpen, title: "Search files" },
    createElement(CommandInput, { "aria-label": "Search text" }),
  );
}

describe("command dialog keyboard dismissal", () => {
  it("closes on Escape before the document dismissal listener is registered", async () => {
    const add = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      if (type !== "keydown") add(type, listener, options);
    });
    render(createElement(SearchDialog));
    const input = await screen.findByLabelText("Search text");
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search files" })).toBeNull();
  });
});
