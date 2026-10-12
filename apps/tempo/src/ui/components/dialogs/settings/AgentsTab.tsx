import { AGENT_IDS, type AgentId } from "@tempo/protocol";
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
import { useCustomAgents } from "~/ui/hooks/useCustomAgents";
import { agentLabel } from "~/ui/lib/agents";
import { cn } from "~/ui/lib/utils";
import { CONFIRM_TEXT, confirm } from "~/ui/state/workspace-ui";
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
} from "./agents-model";

/** Settings → Agents (04): the user's custom agents, with an editor (01, Custom agents). */
export function AgentsTab() {
  const agents = useCustomAgents();
  const [selected, setSelected] = useState<string | "new" | null>(null);

  if (agents.isPending) return <SkeletonRows rows={3} />;
  if (agents.isError) return <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />;

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          A custom agent starts a chat with its own prompt, tools, MCP servers, model and reasoning level.
        </p>
        <Button size="sm" onClick={() => setSelected("new")}>
          <PlusIcon aria-hidden /> New agent
        </Button>
      </div>
      {agents.data.length === 0 && selected !== "new" && <EmptyState title="No custom agents yet." />}
      {agents.data.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Custom agents">
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
                <Badge variant="muted">{agentLabel(a.baseAgent)}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected === "new" && <AgentEditor key="new" initial={emptyForm()} onDone={(id) => setSelected(id)} />}
      {selected !== null && selected !== "new" && (
        <LoadedEditor key={selected} customAgentId={selected} onDone={(id) => setSelected(id)} />
      )}
    </div>
  );
}

function LoadedEditor({
  customAgentId,
  onDone,
}: {
  customAgentId: string;
  onDone: (id: string | null) => void;
}) {
  const agent = useCallQuery("getCustomAgent", { customAgentId });
  if (agent.isPending) return <SkeletonRows rows={6} />;
  if (agent.isError) return <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />;
  return (
    <AgentEditor
      key={agent.data.commitSha}
      customAgentId={customAgentId}
      initial={formFromAgent(agent.data)}
      onDone={onDone}
    />
  );
}

function AgentEditor({
  customAgentId,
  initial,
  onDone,
}: {
  customAgentId?: string;
  initial: AgentForm;
  onDone: (id: string | null) => void;
}) {
  const [form, setForm] = useState(initial);
  const [shown, setShown] = useState<FormErrors>({});
  const change = (patch: Partial<AgentForm>) => setForm((f) => ({ ...f, ...patch }));
  const save = useCallMutation("saveCustomAgent", {
    invalidates: ["listCustomAgents", "getCustomAgent"],
    onSuccess: (saved) => {
      toast.success(`${saved.name} saved`);
      onDone(saved.id);
    },
  });
  const remove = useCallMutation("deleteCustomAgent", {
    invalidates: ["listCustomAgents"],
    onSuccess: () => {
      toast.success(`${initial.name} deleted`);
      onDone(null);
    },
  });

  const submit = () => {
    const { errors, definition } = validateForm(form);
    setShown(errors);
    if (!definition) return;
    save.mutate({ ...(customAgentId ? { customAgentId } : {}), definition });
  };
  const err = (field: string) => shown[field] ?? null;
  const note = UNSUPPORTED_NOTE[form.baseAgent];

  return (
    <form
      noValidate
      aria-label={customAgentId ? `Edit ${initial.name}` : "New agent"}
      className="grid gap-4 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" htmlFor="ca-name" error={err("name")}>
          <Input
            id="ca-name"
            value={form.name}
            maxLength={60}
            onChange={(e) => change({ name: e.target.value })}
          />
        </Field>
        <Field label="Base agent" htmlFor="ca-base" hint={note}>
          <Select value={form.baseAgent} onValueChange={(v) => change({ baseAgent: v as AgentId })}>
            <SelectTrigger id="ca-base" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_IDS.map((a) => (
                <SelectItem key={a} value={a}>
                  {agentLabel(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Description" htmlFor="ca-description" error={err("description")}>
        <Input
          id="ca-description"
          value={form.description}
          maxLength={200}
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
      <fieldset className="grid gap-3">
        <legend className="mb-2 text-sm font-medium">MCP servers</legend>
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
        {customAgentId && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={remove.isPending}
            onClick={async () => {
              if (await confirm(CONFIRM_TEXT.deleteCustomAgent(initial.name)))
                remove.mutate({ customAgentId });
            }}
          >
            <Trash2Icon aria-hidden /> Delete
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => onDone(customAgentId ?? null)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
            <SubmitKbd className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground" />
          </Button>
        </div>
      </div>
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
          <Select value={server.type} onValueChange={(v) => set({ type: v as ServerForm["type"] })}>
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
