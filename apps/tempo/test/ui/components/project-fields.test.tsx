import { elementOf } from "../elements.ts";
import { DEFAULT_SETTINGS, type SettingsLayer } from "@tempo/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import { FieldRow } from "~/ui/components/dialogs/settings/ProjectFields";
import {
  fieldDef,
  formFromLayer,
  layerFromForm,
  type FieldPath,
} from "~/ui/components/dialogs/settings-model";

function Form({ path, layer = {} }: { path: FieldPath; layer?: SettingsLayer }) {
  const settings = {
    ...DEFAULT_SETTINGS,
    scripts: {
      ...DEFAULT_SETTINGS.scripts,
      setup: layer.scripts?.setup ?? "bun install",
      auto_run_after_setup: layer.scripts?.auto_run_after_setup ?? true,
      run: { dev: { command: "bun dev", cwd: "", default: true } },
    },
  };

  const [form, setForm] = useState(() => formFromLayer(layer, settings));
  const [saved, setSaved] = useState<SettingsLayer | null>(null);

  return createElement(
    "div",
    null,
    createElement(FieldRow, {
      def: fieldDef(path),
      state: form[path],
      onChange: (next) => setForm((prev) => ({ ...prev, [path]: next })),
      ctx: {
        settings,
        layer,
        sources: {
          "scripts.setup": layer.scripts?.setup !== undefined ? "tempo" : ".tempo",
          "scripts.auto_run_after_setup": ".tempo",
          "scripts.run.dev": ".tempo",
        },
      },
    }),
    createElement("button", { onClick: () => setSaved(layerFromForm(form).layer) }, "Save"),
    createElement("pre", { "aria-label": "Saved layer" }, JSON.stringify(saved)),
  );
}

const savedLayer = () => JSON.parse(screen.getByLabelText("Saved layer").textContent!);

describe("direct project field editing", () => {
  it("shows inherited values and saves untouched fields without overrides", () => {
    render(createElement(Form, { path: "scripts.setup" }));
    expect(elementOf(screen.getByRole("textbox", { name: "Setup script" }), HTMLTextAreaElement).value).toBe(
      "bun install",
    );
    expect(screen.getByText(".tempo")).toBeDefined();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(savedLayer()).toEqual({});
  });

  it("editing creates an override, including an explicit empty script", () => {
    render(createElement(Form, { path: "scripts.setup" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Setup script" }), { target: { value: "" } });
    expect(screen.getByText("Tempo")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(savedLayer()).toEqual({ scripts: { setup: "" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Reset Setup script to repository or default value" }),
    );
    expect(elementOf(screen.getByRole("textbox", { name: "Setup script" }), HTMLTextAreaElement).value).toBe(
      "bun install",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(savedLayer()).toEqual({});
  });

  it("saves Off as an override of an inherited On value", () => {
    render(createElement(Form, { path: "scripts.auto_run_after_setup" }));
    fireEvent.click(screen.getByRole("switch", { name: "Start the default run script after setup" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(savedLayer()).toEqual({ scripts: { auto_run_after_setup: false } });
  });

  it("resets saved overrides without pretending to know the hidden repository value, and can undo", () => {
    render(createElement(Form, { path: "scripts.setup", layer: { scripts: { setup: "make setup" } } }));
    fireEvent.click(
      screen.getByRole("button", { name: "Reset Setup script to repository or default value" }),
    );
    expect(screen.getByRole("status").textContent).toContain("Save to restore");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(savedLayer()).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "Undo reset" }));
    expect(elementOf(screen.getByRole("textbox", { name: "Setup script" }), HTMLTextAreaElement).value).toBe(
      "make setup",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(savedLayer()).toEqual({ scripts: { setup: "make setup" } });
  });

  it("keeps repository run scripts out of the Tempo editor and save payload", () => {
    render(createElement(Form, { path: "scripts.run" }));
    expect(screen.getByRole("list", { name: "Run scripts in effect" }).textContent).toContain("bun dev");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add run script" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Run script 1 name" }), {
      target: { value: "web" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Run script 1 command" }), {
      target: { value: "bun web" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(savedLayer()).toEqual({ scripts: { run: { web: { command: "bun web", default: true } } } });
    fireEvent.click(screen.getByRole("button", { name: "Remove run script web" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(savedLayer()).toEqual({ scripts: { run: {} } });
    expect(screen.getByRole("list").textContent).toContain("bun dev");
  });
});
