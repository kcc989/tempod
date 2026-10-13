import { DEFAULT_SETTINGS } from "@tempo/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectModels } from "../../src/ui/components/dialogs/settings/ProjectModels";
import { formFromLayer, layerFromForm } from "../../src/ui/components/dialogs/settings-model";
import "./styles.css";

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } },
});
client.setQueryData(["call", "getCredentialStatus", {}], {
  claude: { set: true, updatedAt: null },
  codex: { set: true, updatedAt: null, lastRefresh: null },
  openai: { set: false, updatedAt: null },
  anthropic: { set: false, updatedAt: null },
  openrouter: { set: false, updatedAt: null },
});
client.setQueryData(
  ["call", "listModels", {}],
  [
    {
      agent: "claude",
      currentValue: "claude-one",
      options: [
        { value: "claude-one", name: "Claude One" },
        { value: "claude-two", name: "Claude Two" },
      ],
    },
    { agent: "codex", currentValue: "codex-one", options: [{ value: "codex-one", name: "Codex One" }] },
    { agent: "pi", currentValue: "pi-one", options: [{ value: "pi-one", name: "Disconnected Pi model" }] },
  ],
);
function Preview() {
  const [initial] = useState(() => formFromLayer({}, DEFAULT_SETTINGS));
  const [form, setForm] = useState(initial);
  return (
    <main className="mx-auto max-w-4xl px-8 py-12">
      <p className="mb-4 text-xs text-muted-foreground">Local preview · fixture models · no server changes</p>
      <h1 className="text-2xl font-semibold">Project Agents</h1>
      <ProjectModels
        form={form}
        initial={initial}
        ctx={{ layer: {}, settings: DEFAULT_SETTINGS, sources: null }}
        disabled={false}
        onChange={(changes) => setForm((f) => ({ ...f, ...changes }))}
      />
      <pre aria-label="Unsaved settings" className="mt-6 rounded border p-3 text-xs">
        {JSON.stringify(layerFromForm(form).layer, null, 2)}
      </pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Preview />
  </QueryClientProvider>,
);
