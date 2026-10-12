import { DEFAULT_SETTINGS, type AgentModelOptions, type SettingsLayer } from "@tempo/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { call } from "~/ui/lib/api";
import { ProjectModels } from "~/ui/components/dialogs/settings/ProjectModels";
import { formFromLayer, layerFromForm } from "~/ui/components/dialogs/settings-model";
vi.mock("~/ui/lib/api", () => ({ call: vi.fn(async () => []) }));
const credentials = {
  claude: { set: true, updatedAt: null },
  codex: { set: true, updatedAt: null, lastRefresh: null },
  anthropic: { set: false, updatedAt: null },
  openai: { set: false, updatedAt: null },
  openrouter: { set: false, updatedAt: null },
};
const models: AgentModelOptions[] = [
  { agent: "claude", currentValue: "claude-one", options: [{ value: "claude-one", name: "Claude One" }] },
  { agent: "codex", currentValue: "codex-one", options: [{ value: "codex-one", name: "Codex One" }] },
  { agent: "pi", currentValue: "pi-one", options: [{ value: "pi-one", name: "Pi One" }] },
];
function show(layer: SettingsLayer = {}, disconnected = false, discoveryError = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(
    ["call", "getCredentialStatus", {}],
    disconnected ? { ...credentials, claude: { set: false }, codex: { set: false } } : credentials,
  );
  if (!discoveryError) client.setQueryData(["call", "listModels", {}], models);
  function Form() {
    const [initial] = useState(() => formFromLayer(layer, DEFAULT_SETTINGS));
    const [form, setForm] = useState(initial);
    return (
      <>
        <ProjectModels
          form={form}
          initial={initial}
          ctx={{ layer, settings: null, sources: null }}
          disabled={false}
          onChange={(changes) => setForm((f) => ({ ...f, ...changes }))}
        />
        <pre aria-label="Layer">{JSON.stringify(layerFromForm(form).layer)}</pre>
      </>
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <Form />
    </QueryClientProvider>,
  );
}
const layer = () => JSON.parse(screen.getByLabelText("Layer").textContent!);
async function choose(name: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
describe("project model defaults", () => {
  it("uses reported models without creating overrides on open and filters disconnected agents", async () => {
    show({ agent: { models: { pi: "saved-hidden" } } });
    expect(screen.getByRole("combobox", { name: "Default model" }).textContent).toContain("Claude One");
    expect(layer()).toEqual({ agent: { models: { pi: "saved-hidden" } } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Default model" }), { key: "ArrowDown" });
    await screen.findByRole("option", { name: "Codex One · Codex" });
    expect(screen.queryByRole("option", { name: "Pi One · Pi" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("can explicitly choose the reported default even when its label is already displayed", async () => {
    show();
    await choose("Default model", "Claude One · Claude");
    expect(layer()).toEqual({ agent: { default: "claude", models: { claude: "claude-one" } } });
  });
  it("sets model and agent together, while Advanced changes only the other agent's model", async () => {
    show({ agent: { models: { pi: "saved-hidden" } } });
    await choose("Default model", "Codex One · Codex");
    expect(layer()).toEqual({
      agent: { default: "codex", models: { codex: "codex-one", pi: "saved-hidden" } },
    });
    fireEvent.click(screen.getByText("Advanced"));
    await choose("Claude default model", "Claude One");
    expect(layer().agent.default).toBe("codex");
    expect(layer().agent.models.claude).toBe("claude-one");
    expect(screen.queryByRole("combobox", { name: "Pi default model" })).toBeNull();
  });
  it("preserves unavailable values and supports reset and undo", () => {
    show({ agent: { default: "claude", models: { claude: "no-longer-reported" } } });
    expect(screen.getByRole("status").textContent).toContain("no-longer-reported");
    expect(layer().agent.models.claude).toBe("no-longer-reported");
    fireEvent.click(screen.getByRole("button", { name: "Reset default model to inherited" }));
    expect(layer()).toEqual({});
    expect(screen.getByRole("status").textContent).toContain("Save to restore");
    fireEvent.click(screen.getByRole("button", { name: "Undo reset" }));
    expect(layer().agent.models.claude).toBe("no-longer-reported");
  });
  it("shows loading and lets discovery failures retry without changing the form", async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error("Discovery failed"));
    show({}, false, true);
    expect(screen.getByRole("combobox", { name: "Default model" }).textContent).toContain("Loading models");
    const retry = await screen.findByRole("button", { name: "Retry loading models" });
    expect(layer()).toEqual({});
    vi.mocked(call).mockResolvedValueOnce(models);
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Default model" }).textContent).toContain("Claude One"),
    );
    expect(layer()).toEqual({});
  });
  it("shows the connect route when no agent is connected", () => {
    show({}, true);
    expect(screen.getByRole("status").textContent).toContain("Connect an agent");
    expect(screen.getByRole("button", { name: "Connect another agent" })).toBeTruthy();
    expect(screen.queryByText("Advanced")).toBeNull();
  });
});
