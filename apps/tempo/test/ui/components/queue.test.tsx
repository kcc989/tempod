import { fireEvent, render, screen } from "@testing-library/react";
import type { Turn } from "@tempo/protocol";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueuedChip } from "../../../src/ui/components/chat/ComposerParts";

const turn: Turn = {
  id: "t1",
  sessionId: "s1",
  seq: 1,
  status: "queued",
  queuePos: 1,
  prompt: { text: "Use the smaller change", mentions: [], attachmentIds: [], reviewCommentIds: [] },
  stopReason: null,
  errorCode: null,
  checkpointId: null,
  reverted: false,
  queuedAt: 1,
  startedAt: null,
  endedAt: null,
};

describe("queued message controls", () => {
  it("edits, deletes and changes order with the keyboard", () => {
    const onSave = vi.fn();
    const onDelete = vi.fn();
    const onMove = vi.fn();
    render(
      createElement(QueuedChip, { turn, onSave, onDelete, onMove, onDragStart: vi.fn(), onDrop: vi.fn() }),
    );
    const chip = screen.getByRole("button", { name: turn.prompt.text });
    fireEvent.keyDown(chip, { altKey: true, code: "ArrowRight" });
    expect(onMove).toHaveBeenCalledWith(1);
    fireEvent.click(chip);
    const input = screen.getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(input, { target: { value: "Updated message" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("Updated message");
    fireEvent.click(screen.getByRole("button", { name: "Delete queued message" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows pending steering delivery without queue controls, then restores them on fallback", () => {
    const props = {
      onSave: vi.fn(),
      onDelete: vi.fn(),
      onMove: vi.fn(),
      onDragStart: vi.fn(),
      onDrop: vi.fn(),
    };

    const view = render(createElement(QueuedChip, { ...props, turn: { ...turn, steeringPending: true } }));
    expect(screen.getByRole("status").textContent).toContain("Sending now");
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(createElement(QueuedChip, { ...props, turn: { ...turn, steeringPending: false } }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: turn.prompt.text })).toBeDefined();
  });
});
