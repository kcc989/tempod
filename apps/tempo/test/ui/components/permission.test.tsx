import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ItemOf } from "@tempo/protocol";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ItemView } from "../../../src/ui/components/chat/TranscriptItems";
import { createApiClient, type ApiTransport } from "../../../src/ui/lib/api-client";
import { ApiCallContext } from "../../../src/ui/hooks/useCall";

const request = vi.fn<ApiTransport>(async () => JSON.stringify({ ok: true, value: {} }));

const api = createApiClient(request);

const permission = (over: Partial<ItemOf<"permission">> = {}): ItemOf<"permission"> => ({
  id: "i1",
  sessionId: "s1",
  turnId: "t1",
  kind: "permission",
  status: "pending",
  rev: 1,
  createdAt: 1,
  updatedAt: 1,
  content: {
    requestId: "r1",
    title: "Write source file",
    toolCallId: "tool1",
    chosenOptionId: null,
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  },
  ...over,
});

const show = (item = permission(), writable = true) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

  return render(
    createElement(
      ApiCallContext.Provider,
      { value: api },
      createElement(
        QueryClientProvider,
        { client },
        createElement(ItemView, {
          ctx: { workspaceId: "w1", sessionId: "s1", agent: "claude", writable, canRevert: false },
          item,
          turn: undefined,
        }),
      ),
    ),
  );
};

describe("permission card (04)", () => {
  it("Enter on the focused card sends its first allow option", async () => {
    show();
    const card = screen.getByRole("group", { name: "Permission: Write source file" });
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(card, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("respondPermission", {
        workspaceId: "w1",
        requestId: "r1",
        optionId: "allow",
      }),
    );
  });
  it("Backspace on the card sends its first reject option", async () => {
    show();
    fireEvent.keyDown(screen.getByRole("group"), { key: "Backspace", code: "Backspace" });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("respondPermission", {
        workspaceId: "w1",
        requestId: "r1",
        optionId: "reject",
      }),
    );
  });
  it("does not answer a permission while the composer has focus", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    show();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(request).not.toHaveBeenCalled();
    input.remove();
  });
  it("disables options in an archived or closed chat", () => {
    show(permission(), false);
    const buttons = screen.getAllByRole("button");

    for (const button of buttons) expect(button.getAttribute("disabled")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("group"), { key: "Enter", code: "Enter" });
    expect(request).not.toHaveBeenCalled();
  });
  it("shows the saved answer and removes action buttons", () => {
    const item = permission();
    show({ ...item, status: "completed", content: { ...item.content, chosenOptionId: "allow" } });
    expect(screen.getByText("Chose: Allow once")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
