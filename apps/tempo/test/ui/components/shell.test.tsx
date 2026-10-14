import { createUiEnvironment, requestInput } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { elementOf } from "../elements.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_DOTFILES, TempoError, type DotfilesState } from "@tempo/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellTab } from "../../../src/ui/components/dialogs/settings/ShellTab";
import { resetUiState } from "../../../src/ui/state/workspace-ui";

const saved: DotfilesState = {
  files: [
    { path: ".zshrc", content: "alias g=git\n" },
    { path: ".tmux.conf", content: "set -g mouse on\n" },
    { path: ".gitconfig", content: "[user]\n" },
  ],
  defaults: DEFAULT_DOTFILES,
  saved: true,
  updatedAt: 5,
};

let state: DotfilesState;

const show = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ShellTab />
    </QueryClientProvider>,
    { wrapper: environment.Provider },
  );
};

const editor = (path: string) => elementOf(screen.getByRole("textbox", { name: path }), HTMLTextAreaElement);

const paths = () =>
  within(screen.getByRole("list", { name: "Files" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

const addFile = (path: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Add file" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New file path" }), { target: { value: path } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
};

const updates = () => vi.mocked(call).mock.calls.filter(([name]) => name === "updateDotfiles");

beforeEach(() => {
  state = saved;
  vi.mocked(call).mockImplementation(async (name, input) => {
    if (name === "getDotfiles") return state;

    if (name === "updateDotfiles") return { ...state, files: requestInput("updateDotfiles", input).files };

    return {};
  });
});

afterEach(resetUiState);

describe("Settings → Shell", () => {
  it("lists the files in server order and opens the first", async () => {
    show();
    await screen.findByRole("form", { name: "Shell files" });
    expect(paths()).toEqual([".zshrc", ".tmux.conf", ".gitconfig"]);
    expect(editor(".zshrc").value).toBe("alias g=git\n");
    expect(
      screen.getByText(
        "Terminals use zsh. Changes apply when a workspace starts or wakes. Don't put secrets here; use Environments.",
      ),
    ).toBeTruthy();
  });

  it("rejects reserved and duplicate paths when adding a file", async () => {
    show();
    await screen.findByRole("form", { name: "Shell files" });
    addFile(".ssh/config");
    expect(screen.getByRole("alert").textContent).toContain("not allowed");
    fireEvent.change(screen.getByRole("textbox", { name: "New file path" }), { target: { value: ".zshrc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toBe(".zshrc is listed twice.");
    expect(paths()).toEqual([".zshrc", ".tmux.conf", ".gitconfig"]);
  });

  it("saves the whole list after an edit, an addition and a removal", async () => {
    show();
    await screen.findByRole("form", { name: "Shell files" });
    fireEvent.click(screen.getByRole("button", { name: ".tmux.conf" }));
    fireEvent.change(editor(".tmux.conf"), { target: { value: "set -g mouse off\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove .gitconfig" }));
    addFile(".config/starship.toml");
    fireEvent.change(editor(".config/starship.toml"), { target: { value: "add_newline = false\n" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("updateDotfiles", {
        files: [
          { path: ".zshrc", content: "alias g=git\n" },
          { path: ".tmux.conf", content: "set -g mouse off\n" },
          { path: ".config/starship.toml", content: "add_newline = false\n" },
        ],
      }),
    );
  });

  it("resets to the defaults without saving", async () => {
    show();
    await screen.findByRole("form", { name: "Shell files" });
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(paths()).toEqual([".zshrc", ".tmux.conf"]);
    expect(editor(".zshrc").value).toBe(DEFAULT_DOTFILES[0]!.content);
    expect(elementOf(screen.getByRole("button", { name: /^Save/ }), HTMLButtonElement).disabled).toBe(false);
    expect(updates()).toEqual([]);
  });

  it("blocks a file over 64 KB before saving", async () => {
    show();
    await screen.findByRole("form", { name: "Shell files" });
    fireEvent.change(editor(".zshrc"), { target: { value: "x".repeat(64 * 1024 + 1) } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    expect(screen.getByRole("alert").textContent).toBe(".zshrc is larger than 64 KB.");
    expect(updates()).toEqual([]);
  });

  it("shows DOTFILES_CHANGED with Reload, which loads the newer files", async () => {
    vi.mocked(call).mockImplementation(async (name) => {
      if (name === "getDotfiles") return state;

      if (name === "updateDotfiles") {
        state = { ...saved, files: [{ path: ".zshrc", content: "# from another tab\n" }], updatedAt: 9 };
        throw new TempoError("DOTFILES_CHANGED");
      }

      return {};
    });
    show();
    await screen.findByRole("form", { name: "Shell files" });
    fireEvent.change(editor(".zshrc"), { target: { value: "# mine\n" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your shell files changed while saving. Reload them and try again.");
    fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(editor(".zshrc").value).toBe("# from another tab\n"));
    expect(paths()).toEqual([".zshrc"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
