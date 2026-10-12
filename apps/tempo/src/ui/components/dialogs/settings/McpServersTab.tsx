import { mcpInputProblem, type McpServer, type McpServerInput, type McpTransport } from "@tempo/protocol";
import { PencilIcon, PlusIcon, ServerIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Switch } from "~/ui/components/ui/switch";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { errorCode, errorDetail, errorText, toastError } from "~/ui/lib/toast";
import { confirm } from "~/ui/state/workspace-ui";
import { nextRowKey } from "../settings-model";
import { Field } from "../parts";

const TRANSPORTS: ReadonlyArray<McpTransport> = ["stdio", "http", "sse"];

interface EnvRow {
  readonly key: number;
  readonly name: string;
  readonly value: string;
}
interface HeaderRow extends EnvRow {
  readonly secret: boolean;
}
export interface McpForm {
  readonly id?: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: McpTransport;
  readonly command: string;
  readonly args: string;
  readonly env: ReadonlyArray<EnvRow>;
  readonly url: string;
  readonly headers: ReadonlyArray<HeaderRow>;
}

const EMPTY_FORM: McpForm = {
  name: "",
  enabled: true,
  transport: "stdio",
  command: "",
  args: "",
  env: [],
  url: "",
  headers: [],
};

/** Lowercase names of secret headers that have a stored value. */
const storedSecrets = (server: McpServer | undefined): ReadonlySet<string> =>
  new Set(server?.headers.filter((h) => h.secret && h.set).map((h) => h.name.toLowerCase()) ?? []);

const formOf = (s: McpServer): McpForm => ({
  id: s.id,
  name: s.name,
  enabled: s.enabled,
  transport: s.transport,
  command: s.command ?? "",
  args: s.args.join("\n"),
  env: s.env.map((e) => ({ key: nextRowKey(), ...e })),
  url: s.url ?? "",
  headers: s.headers.map((h) => ({
    key: nextRowKey(),
    name: h.name,
    secret: h.secret,
    value: h.value ?? "",
  })),
});

/** Only the fields valid for the transport. An empty secret value is left out so the stored one is kept. */
export const inputOf = (f: McpForm): McpServerInput => {
  const base = {
    ...(f.id ? { id: f.id } : {}),
    name: f.name.trim(),
    enabled: f.enabled,
    transport: f.transport,
  };
  if (f.transport === "stdio")
    return {
      ...base,
      command: f.command.trim(),
      args: f.args.split("\n").filter((a) => a.trim() !== ""),
      env: f.env.filter((e) => e.name || e.value).map((e) => ({ name: e.name.trim(), value: e.value })),
    };
  return {
    ...base,
    url: f.url.trim(),
    headers: f.headers
      .filter((h) => h.name || h.value)
      .map((h) =>
        h.secret && h.value === ""
          ? { name: h.name.trim(), secret: true }
          : { name: h.name.trim(), secret: h.secret, value: h.value },
      ),
  };
};

/** Settings → MCP servers (04): the owner's MCP servers for every agent and project. */
export function McpServersTab() {
  const servers = useCallQuery("listMcpServers", {});
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const remove = useCallMutation("deleteMcpServer", {
    invalidates: ["listMcpServers"],
    onSuccess: () => toast.success("MCP server deleted"),
  });

  if (servers.isPending) return <SkeletonRows rows={3} />;
  if (servers.isError) return <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />;

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Agents get these servers in every project. Changes apply to new sessions.
      </p>
      {editing ? (
        <ServerForm
          key={editing === "new" ? "new" : editing.id}
          server={editing === "new" ? undefined : editing}
          onDone={() => setEditing(null)}
        />
      ) : (
        <Button size="sm" className="w-fit" onClick={() => setEditing("new")}>
          <PlusIcon aria-hidden />
          Add server
        </Button>
      )}
      {servers.data.length === 0 ? (
        <EmptyState icon={ServerIcon} title="No MCP servers." />
      ) : (
        <ul aria-label="MCP servers" className="flex flex-col divide-y rounded-lg border">
          {servers.data.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              onEdit={() => setEditing(s)}
              onDelete={async () => {
                const ok = await confirm({
                  title: `Delete ${s.name}?`,
                  description: "New sessions no longer get this server. Its secret headers are deleted.",
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (!ok) return;
                if (editing !== "new" && editing?.id === s.id) setEditing(null);
                remove.mutate({ id: s.id });
              }}
              deleting={remove.isPending}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ServerRow({
  server: s,
  onEdit,
  onDelete,
  deleting,
}: {
  server: McpServer;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const toggle = useCallMutation("saveMcpServer", { invalidates: ["listMcpServers"] });
  const target = s.transport === "stdio" ? [s.command, ...s.args].join(" ") : (s.url ?? "");
  return (
    <li aria-label={s.name} className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium">{s.name}</span>
          <span className="text-xs text-muted-foreground">{s.transport}</span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground" title={target}>
          {target}
        </p>
      </div>
      <Switch
        aria-label={`Enable ${s.name}`}
        checked={s.enabled}
        disabled={toggle.isPending}
        onCheckedChange={(enabled) => toggle.mutate(inputOf({ ...formOf(s), enabled }))}
      />
      <Button size="sm" variant="ghost" aria-label={`Edit ${s.name}`} onClick={onEdit}>
        <PencilIcon aria-hidden />
        Edit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive"
        aria-label={`Delete ${s.name}`}
        disabled={deleting}
        onClick={onDelete}
      >
        <Trash2Icon aria-hidden />
        Delete
      </Button>
    </li>
  );
}

function ServerForm({ server, onDone }: { server: McpServer | undefined; onDone: () => void }) {
  const [form, setForm] = useState<McpForm>(() => (server ? formOf(server) : EMPTY_FORM));
  const [error, setError] = useState<string | null>(null);
  const stored = storedSecrets(server);
  const save = useCallMutation("saveMcpServer", {
    toast: false,
    invalidates: ["listMcpServers"],
    onSuccess: (s) => {
      toast.success(`${s.name} saved`);
      onDone();
    },
    onError: (e) => {
      if (errorCode(e) === "VALIDATION_FAILED") {
        const detail = errorDetail(e);
        setError(detail ? `${errorText(e)} ${detail}` : errorText(e));
      } else toastError(e);
    },
  });
  const set = (p: Partial<McpForm>) => setForm((f) => ({ ...f, ...p }));
  const formId = server ? `mcp-${server.id}` : "mcp-new";

  return (
    <form
      aria-label={server ? `Edit ${server.name}` : "Add MCP server"}
      className="grid gap-4 rounded-lg border p-4"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const input = inputOf(form);
        const problem = mcpInputProblem(input, stored);
        setError(problem);
        if (!problem) save.mutate(input);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <Field label="Name" htmlFor={`${formId}-name`}>
          <Input
            id={`${formId}-name`}
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="github"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Transport" htmlFor={`${formId}-transport`}>
          <Select
            value={form.transport}
            onValueChange={(v) => {
              const transport = TRANSPORTS.find((t) => t === v);
              if (transport) set({ transport });
            }}
          >
            <SelectTrigger id={`${formId}-transport`} aria-label="Transport">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSPORTS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {form.transport === "stdio" ? (
        <>
          <Field label="Command" htmlFor={`${formId}-command`}>
            <Input
              id={`${formId}-command`}
              value={form.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="npx"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Arguments" htmlFor={`${formId}-args`} hint="One per line.">
            <Textarea
              id={`${formId}-args`}
              value={form.args}
              onChange={(e) => set({ args: e.target.value })}
              placeholder={"-y\n@modelcontextprotocol/server-everything"}
              spellCheck={false}
              className="max-h-48 font-mono text-xs"
            />
          </Field>
          <Field label="Env vars" hint="Stored as plain text, not as secrets.">
            <PairRows
              rows={form.env}
              noun="Env var"
              namePlaceholder="LOG_LEVEL"
              onChange={(env) => set({ env })}
              onAdd={() => set({ env: [...form.env, { key: nextRowKey(), name: "", value: "" }] })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" htmlFor={`${formId}-url`}>
            <Input
              id={`${formId}-url`}
              type="url"
              value={form.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Headers" hint="Secret values are never shown again.">
            <div className="grid gap-2">
              {form.headers.map((h, i) => {
                const patch = (p: Partial<HeaderRow>) =>
                  set({ headers: form.headers.map((x) => (x.key === h.key ? { ...x, ...p } : x)) });
                const keeps = h.secret && stored.has(h.name.trim().toLowerCase());
                return (
                  <div
                    key={h.key}
                    className="grid grid-cols-[10rem_minmax(0,1fr)_auto_auto] items-center gap-1.5"
                  >
                    <Input
                      aria-label={`Header ${i + 1} name`}
                      placeholder="Authorization"
                      value={h.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                    <Input
                      aria-label={`Header ${i + 1} value`}
                      type={h.secret ? "password" : "text"}
                      placeholder={keeps ? "Saved — leave empty to keep" : "Value"}
                      value={h.value}
                      onChange={(e) => patch({ value: e.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch
                        aria-label={`Header ${i + 1} secret`}
                        checked={h.secret}
                        onCheckedChange={(secret) => patch({ secret })}
                      />
                      Secret
                    </label>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove header ${h.name || i + 1}`}
                      onClick={() => set({ headers: form.headers.filter((x) => x.key !== h.key) })}
                    >
                      <XIcon />
                    </Button>
                  </div>
                );
              })}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() =>
                  set({
                    headers: [...form.headers, { key: nextRowKey(), name: "", value: "", secret: true }],
                  })
                }
              >
                <PlusIcon aria-hidden />
                Add header
              </Button>
            </div>
          </Field>
        </>
      )}
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={form.enabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Enabled" />
        Enabled
      </label>
      <div className="flex items-center gap-2">
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <span className="ml-auto text-xs text-muted-foreground">Changes apply to new sessions.</span>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function PairRows({
  rows,
  noun,
  namePlaceholder,
  onChange,
  onAdd,
}: {
  rows: ReadonlyArray<EnvRow>;
  noun: string;
  namePlaceholder: string;
  onChange: (rows: ReadonlyArray<EnvRow>) => void;
  onAdd: () => void;
}) {
  const patch = (key: number, p: Partial<EnvRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  return (
    <div className="grid gap-2">
      {rows.map((r, i) => (
        <div key={r.key} className="grid grid-cols-[10rem_minmax(0,1fr)_auto] items-center gap-1.5">
          <Input
            aria-label={`${noun} ${i + 1} name`}
            placeholder={namePlaceholder}
            value={r.name}
            onChange={(e) => patch(r.key, { name: e.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Input
            aria-label={`${noun} ${i + 1} value`}
            value={r.value}
            onChange={(e) => patch(r.key, { value: e.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${noun.toLowerCase()} ${r.name || i + 1}`}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={onAdd}>
        <PlusIcon aria-hidden />
        Add {noun.toLowerCase()}
      </Button>
    </div>
  );
}
