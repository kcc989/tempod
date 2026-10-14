import { Schema } from "effect";
import { AGENT_IDS, AgentBase, AgentAccess, OutputKind, McpTransport } from "@tempo/protocol";
import { BotIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Field, SubmitKbd } from "~/ui/components/dialogs/parts";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Switch } from "~/ui/components/ui/switch";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { useAgents } from "~/ui/hooks/useAgents";
import { agentLabel, hasLogin } from "~/ui/lib/agents";
import { cn } from "~/ui/lib/utils";
import { CONFIRM_TEXT, confirm, openDialog } from "~/ui/state/workspace-ui";
import {
  addTags,
  emptyForm,
  emptyServer,
  formFromAgent,
  UNSUPPORTED_NOTE,
  validateForm,
  type AgentForm,
  type FormErrors,
  type ServerForm,
} from "./library-model";

/** Settings → Agents (04): the user's agents, with an editor (01, Agents). */
export function LibraryTab() {
  const agents = useAgents();
  const credentials = useCredentialStatus();
  const available = AGENT_IDS.filter((a) => credentials.isSuccess && hasLogin(a, credentials.data));
  const [draft, setDraft] = useState(emptyForm());
  const [selected, setSelected] = useState<string | "new" | null>(null);

  if (agents.isPending) return <SkeletonRows rows={3} />;

  if (agents.isError) return <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />;

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={() => openDialog({ kind: "settings", tab: "logins" })}>
          Connect another agent
        </Button>
        <Button
          size="sm"
          variant={selected === null ? "default" : "ghost"}
          disabled={available.length === 0}
          onClick={() => {
            setDraft({ ...emptyForm(), baseAgent: available[0] ?? "auto" });
            setSelected("new");
          }}
        >
          <PlusIcon aria-hidden /> New agent
        </Button>
      </div>
      {credentials.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading logins…
        </p>
      )}
      {credentials.isError && (
        <ErrorState error={credentials.error} onRetry={() => void credentials.refetch()} />
      )}
      {credentials.isSuccess && available.length === 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          Connect an agent in Logins to create an agent.
        </p>
      )}
      {agents.data.length === 0 && selected !== "new" && <EmptyState title="No agents yet." />}
      {agents.data.length > 0 && (
        <ul className="flex flex-col divide-y border-b" aria-label="Agents">
          {agents.data.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                aria-current={selected === a.id ? "true" : undefined}
                onClick={() => setSelected(a.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  selected === a.id && "bg-accent",
                )}
              >
                <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{a.name}</span>
                  {a.description && (
                    <span className="block truncate text-xs text-muted-foreground">{a.description}</span>
                  )}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <Badge variant="muted">
                    {a.baseAgent === "auto" ? "Project default" : agentLabel(a.baseAgent)}
                  </Badge>
                  {a.baseAgent !== "auto" && (
                    <span className="text-xs text-muted-foreground">
                      {credentials.isSuccess
                        ? hasLogin(a.baseAgent, credentials.data)
                          ? "Connected"
                          : "Login required"
                        : credentials.isError
                          ? "Login unavailable"
                          : "Checking login…"}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected === "new" && <AgentEditor key="new" initial={draft} onDone={(id) => setSelected(id)} />}
      {selected !== null && selected !== "new" && (
        <LoadedEditor
          key={selected}
          agentId={selected}
          onDone={(id) => setSelected(id)}
          onDuplicate={(form) => {
            setDraft({
              ...form,
              handle: form.handle.slice(0, 27) + "-copy",
              name: form.name.slice(0, 55) + " copy",
            });
            setSelected("new");
          }}
        />
      )}
    </div>
  );
}

function LoadedEditor({
  agentId,
  onDone,
  onDuplicate,
}: {
  agentId: string;
  onDuplicate: (form: AgentForm) => void;
  onDone: (id: string | null) => void;
}) {
  const agent = useCallQuery("getAgent", { agentId });

  if (agent.isPending) return <SkeletonRows rows={6} />;

  if (agent.isError) return <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />;

  return (
    <div className="grid gap-3">
      <Button onClick={() => onDuplicate(formFromAgent(agent.data))}>Duplicate</Button>
      <AgentEditor
        key={agent.data.sha}
        agentId={agentId}
        initial={formFromAgent(agent.data)}
        onDone={onDone}
      />
    </div>
  );
}

function AgentEditor({
  agentId,
  initial,
  onDone,
}: {
  agentId?: string;
  initial: AgentForm;
  onDone: (id: string | null) => void;
}) {
  const [form, setForm] = useState(initial);
  const [shown, setShown] = useState<FormErrors>({});
  const credentials = useCredentialStatus();
  const available = AGENT_IDS.filter((a) => credentials.isSuccess && hasLogin(a, credentials.data));
  const connected = form.baseAgent === "auto" ? available.length > 0 : available.includes(form.baseAgent);
  const canSave = Boolean(agentId) || connected;
  const change = (patch: Partial<AgentForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = useCallMutation("saveAgent", {
    invalidates: ["listAgents", "getAgent"],
    onSuccess: (saved) => {
      toast.success(`${saved.name} saved`);
      onDone(saved.id);
    },
  });

  const remove = useCallMutation("deleteAgent", {
    invalidates: ["listAgents"],
    onSuccess: () => {
      toast.success(`${initial.name} deleted`);
      onDone(null);
    },
  });

  const submit = () => {
    if (!canSave) return;
    const { errors, definition } = validateForm(form);
    setShown(errors);

    if (!definition) return;
    let input: import("@tempo/protocol").FnInput<"saveAgent"> = { definition };

    if (agentId) input = { ...input, agentId };
    save.mutate(input);
  };

  const err = (field: string) => shown[field] ?? null;
  const note = UNSUPPORTED_NOTE[form.baseAgent];

  return (
    <form
      noValidate
      aria-label={agentId ? `Edit ${initial.name}` : "New agent"}
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="Handle" htmlFor="agent-handle" error={err("handle")}>
        <Input
          id="agent-handle"
          value={form.handle}
          maxLength={32}
          onChange={(e) => change({ handle: e.target.value })}
        />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Access" htmlFor="agent-access">
          <select
            id="agent-access"
            value={form.access}
            onChange={(e) => {
              if (Schema.is(AgentAccess)(e.target.value)) change({ access: e.target.value });
            }}
          >
            <option value="read-only">Read-only</option>
            <option value="write">Write</option>
          </select>
        </Field>
        <Field label="Output kind" htmlFor="agent-output">
          <select
            id="agent-output"
            value={form.outputKind}
            onChange={(e) => {
              if (Schema.is(OutputKind)(e.target.value)) change({ outputKind: e.target.value });
            }}
          >
            <option value="plan">Plan</option>
            <option value="review">Review</option>
            <option value="note">Note</option>
          </select>
        </Field>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" htmlFor="ca-name" error={err("name")}>
          <Input
            id="ca-name"
            value={form.name}
            maxLength={60}
            onChange={(e) => change({ name: e.target.value })}
          />
        </Field>
        <Field label="Base agent" htmlFor="ca-base">
          <Select
            value={form.baseAgent}
            disabled={available.length === 0}
            onValueChange={(v) => {
              if (Schema.is(AgentBase)(v)) change({ baseAgent: v });
            }}
          >
            <SelectTrigger id="ca-base" className="w-full">
              <SelectValue>
                {form.baseAgent === "auto" ? "Project default" : agentLabel(form.baseAgent)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {["auto" as const, ...available].map((a) => (
                <SelectItem key={a} value={a}>
                  {a === "auto" ? "Project default" : agentLabel(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="min-h-5 text-xs text-muted-foreground">{note}</p>
          {credentials.isSuccess && form.baseAgent !== "auto" && !connected && (
            <p role="status" className="text-xs text-muted-foreground">
              {agentLabel(form.baseAgent)} is not connected. Its saved base agent is unchanged. Connect it in
              Logins or choose a connected agent.
            </p>
          )}
        </Field>
      </div>
      <Field label="Description" htmlFor="ca-description" error={err("description")}>
        <Input
          id="ca-description"
          value={form.description}
          maxLength={500}
          onChange={(e) => change({ description: e.target.value })}
        />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Model"
          htmlFor="ca-model"
          hint="The agent's model value. The agent reports the choices."
        >
          <Input
            id="ca-model"
            placeholder="Agent default"
            value={form.model}
            onChange={(e) => change({ model: e.target.value })}
          />
        </Field>
        <Field label="Reasoning level" htmlFor="ca-level" hint="For example low, medium or high.">
          <Input
            id="ca-level"
            placeholder="Agent default"
            value={form.thoughtLevel}
            onChange={(e) => change({ thoughtLevel: e.target.value })}
          />
        </Field>
      </div>
      <Field
        label="System prompt"
        htmlFor="ca-prompt"
        error={err("systemPrompt")}
        hint={`${form.systemPrompt.length.toLocaleString("en-US")} / 32,000`}
      >
        <Textarea
          id="ca-prompt"
          rows={6}
          value={form.systemPrompt}
          onChange={(e) => change({ systemPrompt: e.target.value })}
        />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Allowed tools"
          error={err("allow")}
          hint="Empty allows every built-in tool. Denied wins."
        >
          <TagInput label="Allowed tools" values={form.allow} onChange={(allow) => change({ allow })} />
        </Field>
        <Field
          label="Denied tools"
          error={err("deny")}
          hint="Use the base agent's tool names, for example Edit."
        >
          <TagInput label="Denied tools" values={form.deny} onChange={(deny) => change({ deny })} />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
        <label htmlFor="ca-playwright" className="text-sm font-medium">
          Playwright browser
        </label>
        <Switch
          id="ca-playwright"
          checked={form.playwright}
          onCheckedChange={(playwright) => change({ playwright })}
        />
      </div>
      <fieldset className="grid gap-3 border-t pt-4">
        <legend className="mb-2 text-sm font-medium">MCP servers</legend>
        {form.servers.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Add a server to make its tools available to this agent.
          </p>
        )}
        {err("servers") && (
          <p role="alert" className="text-xs text-destructive">
            {err("servers")}
          </p>
        )}
        {form.servers.map((s, i) => (
          <ServerRow
            key={s.key}
            server={s}
            errors={shown}
            onChange={(next) => change({ servers: form.servers.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => change({ servers: form.servers.filter((_, j) => j !== i) })}
          />
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => change({ servers: [...form.servers, emptyServer()] })}
        >
          <PlusIcon aria-hidden /> Add MCP server
        </Button>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        {err("form") && (
          <p role="alert" className="text-xs text-destructive">
            {err("form")}
          </p>
        )}
        {agentId && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={remove.isPending}
            onClick={async () => {
              if (await confirm(CONFIRM_TEXT.deleteAgent(initial.name))) remove.mutate({ agentId });
            }}
          >
            <Trash2Icon aria-hidden /> Delete
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => onDone(agentId ?? null)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={save.isPending || !canSave}>
            {save.isPending ? "Saving…" : "Save"}
            <SubmitKbd className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground" />
          </Button>
        </div>
      </div>
      <details>
        <summary>Definition JSON</summary>
        <pre className="overflow-auto whitespace-pre-wrap text-xs">
          {validateForm(form).definition
            ? JSON.stringify(validateForm(form).definition, null, 2)
            : "Complete the fields to preview the definition."}
        </pre>
      </details>
    </form>
  );
}

function ServerRow({
  server,
  errors,
  onChange,
  onRemove,
}: {
  server: ServerForm;
  errors: FormErrors;
  onChange: (next: ServerForm) => void;
  onRemove: () => void;
}) {
  const id = (f: string) => `ca-${server.key}-${f}`;
  const err = (f: string) => errors[`server.${server.key}.${f}`] ?? null;
  const set = (patch: Partial<ServerForm>) => onChange({ ...server, ...patch });

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="grid gap-3 md:grid-cols-[1fr_8rem_auto] md:items-end">
        <Field label="Name" htmlFor={id("name")} error={err("name")}>
          <Input id={id("name")} value={server.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Type" htmlFor={id("type")}>
          <Select
            value={server.type}
            onValueChange={(v) => {
              if (Schema.is(McpTransport)(v)) set({ type: v });
            }}
          >
            <SelectTrigger id={id("type")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${server.name || "server"}`}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      </div>
      {server.type === "stdio" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Command" htmlFor={id("command")} error={err("command")}>
            <Input
              id={id("command")}
              value={server.command}
              onChange={(e) => set({ command: e.target.value })}
            />
          </Field>
          <Field label="Arguments">
            <TagInput label="Arguments" values={server.args} onChange={(args) => set({ args })} />
          </Field>
        </div>
      ) : (
        <Field label="URL" htmlFor={id("url")} error={err("url")}>
          <Input
            id={id("url")}
            placeholder="https://"
            value={server.url}
            onChange={(e) => set({ url: e.target.value })}
          />
        </Field>
      )}
      <Field
        label={server.type === "stdio" ? "Env" : "Headers"}
        htmlFor={id("vars")}
        error={err("vars")}
        hint="One NAME=${SECRET} per line. Uses a project env var or secret."
      >
        <Textarea
          id={id("vars")}
          rows={2}
          className="font-mono text-xs"
          value={server.vars}
          onChange={(e) => set({ vars: e.target.value })}
        />
      </Field>
    </div>
  );
}

/** Chips with a text box: Enter, comma or space adds; Backspace on an empty box removes the last. */
function TagInput({
  label,
  values,
  onChange,
}: {
  label: string;
  values: ReadonlyArray<string>;
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState("");

  const commit = () => {
    if (text.trim()) onChange(addTags(values, text));
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      if (!text.trim()) return;
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !text && values.length > 0) onChange(values.slice(0, -1));
  };

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border px-2 py-1">
      {values.map((v) => (
        <Badge key={v} variant="muted" className="gap-1 font-mono">
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            className="rounded-sm hover:text-foreground"
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        aria-label={label}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </div>
  );
}
