import type { Environment } from "@tempo/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { NetworkIcon, PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Textarea } from "~/ui/components/ui/textarea";
import { invalidateCalls, useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { call } from "~/ui/lib/api";
import { errorCode, errorDetail, errorText, toastError } from "~/ui/lib/toast";
import { cn } from "~/ui/lib/utils";
import { confirm } from "~/ui/state/workspace-ui";
import {
  deleteEnvironmentConfirm,
  EGRESS_POLICY_OPTIONS,
  emptyInjectorRow,
  emptySecretRow,
  formFromEnvironment,
  formSignature,
  secretHint,
  updateFromForm,
  type EnvironmentForm,
  type FormErrors,
  type InjectorRow,
  type SecretRow,
} from "../environments-model";
import { Field, SubmitKbd } from "../parts";

const INLINE_CODES = new Set(["VALIDATION_FAILED", "ENVIRONMENT_EXISTS"]);
const problemText = (e: unknown): string => {
  const detail = errorDetail(e);
  return detail ? `${errorText(e)} ${detail}` : errorText(e);
};

/** Settings → Environments (04): named environments with egress rules, secrets and injectors. */
export function EnvironmentsTab() {
  const envs = useCallQuery("listEnvironments", {});
  const [selected, setSelected] = useState<string | null>(null);

  if (envs.isPending) return <SkeletonRows rows={6} />;
  if (envs.isError) return <ErrorState error={envs.error} onRetry={() => void envs.refetch()} />;
  const list = envs.data;
  const current = list.find((e) => e.id === selected) ?? list[0];

  return (
    <div className="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
      <div className="grid content-start gap-3">
        <NewEnvironment onCreated={(env) => setSelected(env.id)} />
        {list.length > 0 && (
          <ul aria-label="Environments" className="grid gap-0.5">
            {list.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  aria-current={e.id === current?.id ? "true" : undefined}
                  onClick={() => setSelected(e.id)}
                  className={cn(
                    "w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    e.id === current?.id && "bg-accent font-medium text-accent-foreground",
                  )}
                >
                  {e.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {current ? (
        <EnvironmentEditor
          key={`${current.id}:${current.updatedAt}:${current.secrets.map((s) => `${s.name}=${s.set}`).join()}`}
          env={current}
        />
      ) : (
        <EmptyState
          icon={NetworkIcon}
          title="No environments."
          description="An environment holds egress rules, secrets and injectors that projects can share."
        />
      )}
    </div>
  );
}

function NewEnvironment({ onCreated }: { onCreated: (env: Environment) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCallMutation("createEnvironment", {
    toast: false,
    invalidates: ["listEnvironments"],
    onSuccess: (env) => {
      setOpen(false);
      setName("");
      setError(null);
      onCreated(env);
      toast.success(`${env.name} created`);
    },
    onError: (e) => (INLINE_CODES.has(errorCode(e) ?? "") ? setError(problemText(e)) : toastError(e)),
  });
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden />
        New environment
      </Button>
    );
  }
  return (
    <form
      className="grid gap-1.5"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim();
        if (n === "") return setError("Enter a name.");
        create.mutate({ name: n });
      }}
    >
      <Input
        aria-label="New environment name"
        placeholder="Name"
        autoFocus
        maxLength={64}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.code === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        aria-invalid={error ? true : undefined}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" disabled={create.isPending}>
          Create
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EnvironmentEditor({ env }: { env: Environment }) {
  const queryClient = useQueryClient();
  const [initial] = useState(() => formFromEnvironment(env));
  const [form, setForm] = useState<EnvironmentForm>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const initialSig = useMemo(() => formSignature(initial), [initial]);
  const dirty = formSignature(form) !== initialSig;

  const remove = useCallMutation("deleteEnvironment", {
    invalidates: ["listEnvironments", "listProjects"],
    onSuccess: () => toast.success(`${env.name} deleted`),
  });

  const patch = (p: Partial<EnvironmentForm>) => setForm((f) => ({ ...f, ...p }));

  const submit = async () => {
    const parsed = updateFromForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setProblem("Check the highlighted fields.");
      return;
    }
    setErrors({});
    setProblem(null);
    setSaving(true);
    try {
      await call("updateEnvironment", { environmentId: env.id, ...parsed.update });
      for (const v of parsed.values) {
        await call("setEnvironmentSecret", { environmentId: env.id, name: v.name, value: v.value });
      }
      setForm((f) => ({ ...f, secrets: f.secrets.map((r) => ({ ...r, value: "" })) }));
      toast.success("Environment saved");
    } catch (e) {
      if (INLINE_CODES.has(errorCode(e) ?? "")) setProblem(problemText(e));
      else toastError(e);
    } finally {
      setSaving(false);
      await invalidateCalls(queryClient, "listEnvironments");
    }
  };

  return (
    <form
      noValidate
      autoComplete="off"
      aria-label={`Environment ${env.name}`}
      className="grid min-w-0 gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Name" htmlFor="env-name" error={errors.name ?? null}>
        <Input
          id="env-name"
          value={form.name}
          maxLength={64}
          onChange={(e) => patch({ name: e.target.value })}
          aria-invalid={errors.name ? true : undefined}
          className="max-w-sm"
        />
      </Field>
      <Field label="Egress policy" htmlFor="env-policy">
        <Select
          value={form.egressPolicy}
          onValueChange={(v) => patch({ egressPolicy: v as EnvironmentForm["egressPolicy"] })}
        >
          <SelectTrigger id="env-policy" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EGRESS_POLICY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Allowlist"
        htmlFor="env-allowlist"
        hint="One pattern per line. *.example.com is allowed."
        error={errors.allowlist ?? null}
      >
        <Textarea
          id="env-allowlist"
          value={form.allowlist}
          onChange={(e) => patch({ allowlist: e.target.value })}
          spellCheck={false}
          placeholder={"example.com\n*.example.com"}
          aria-invalid={errors.allowlist ? true : undefined}
          className="max-h-60 font-mono text-xs"
        />
      </Field>
      <SecretsEditor rows={form.secrets} onChange={(secrets) => patch({ secrets })} error={errors.secrets} />
      <InjectorsEditor
        rows={form.injectors}
        onChange={(injectors) => patch({ injectors })}
        error={errors.injectors}
      />
      <section aria-labelledby="env-delete" className="grid gap-2 border-t pt-3">
        <h3 id="env-delete" className="text-sm font-semibold">
          Delete environment
        </h3>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="w-fit"
          disabled={remove.isPending}
          onClick={async () => {
            if (await confirm(deleteEnvironmentConfirm(env.name))) remove.mutate({ environmentId: env.id });
          }}
        >
          Delete
        </Button>
      </section>
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-background py-2">
        {problem && (
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            {problem}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => {
              setForm(initial);
              setErrors({});
              setProblem(null);
            }}
          >
            Reset
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
            <SubmitKbd className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground" />
          </Button>
        </div>
      </div>
    </form>
  );
}

function SecretsEditor({
  rows,
  onChange,
  error,
}: {
  rows: ReadonlyArray<SecretRow>;
  onChange: (rows: ReadonlyArray<SecretRow>) => void;
  error: string | undefined;
}) {
  const patch = (key: number, p: Partial<SecretRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  return (
    <section aria-labelledby="env-secrets" className="grid gap-2 border-t pt-3">
      <h3 id="env-secrets" className="text-sm font-semibold">
        Secrets
      </h3>
      <p className="text-xs text-muted-foreground">
        Values are never shown again. Leave a value empty to keep the stored one.
      </p>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No secrets.</p>}
      <ul className="grid gap-3">
        {rows.map((r, i) => {
          const label = r.name.trim() || `Secret ${i + 1}`;
          const hint = secretHint(r.name, r.hosts);
          return (
            <li key={r.key} className="grid gap-1.5 rounded-md border p-2">
              <div className="grid gap-1.5 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                <Input
                  aria-label={`Secret ${i + 1} name`}
                  placeholder="API_TOKEN"
                  value={r.name}
                  readOnly={!r.isNew}
                  onChange={(e) => patch(r.key, { name: e.target.value.toUpperCase() })}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <Input
                  aria-label={`${label} hosts`}
                  placeholder="api.example.com, *.example.com"
                  value={r.hosts}
                  onChange={(e) => patch(r.key, { hosts: e.target.value })}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <Input
                  aria-label={`${label} value`}
                  type="password"
                  placeholder={r.set ? "Replace value" : "Value"}
                  value={r.value}
                  onChange={(e) => patch(r.key, { value: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${label}`}
                  onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
                >
                  <XIcon />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={r.set ? "success" : "muted"}>{r.set ? "Set" : "Not set"}</Badge>
                <span
                  className={cn(
                    "min-w-0 break-words",
                    hint.tone === "warning" ? "text-warning" : "text-muted-foreground",
                  )}
                >
                  {hint.text}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        onClick={() => onChange([...rows, emptySecretRow()])}
      >
        <PlusIcon aria-hidden />
        Add secret
      </Button>
    </section>
  );
}

function InjectorsEditor({
  rows,
  onChange,
  error,
}: {
  rows: ReadonlyArray<InjectorRow>;
  onChange: (rows: ReadonlyArray<InjectorRow>) => void;
  error: string | undefined;
}) {
  const patch = (key: number, p: Partial<InjectorRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  return (
    <section aria-labelledby="env-injectors" className="grid gap-2 border-t pt-3">
      <h3 id="env-injectors" className="text-sm font-semibold">
        Injectors
      </h3>
      <p className="text-xs text-muted-foreground">
        An ES module whose default export has fetch(request, env). It signs requests to its hosts with
        env.SECRETS.hmac.
      </p>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No injectors.</p>}
      <ul className="grid gap-3">
        {rows.map((r, i) => {
          const label = r.name.trim() || `Injector ${i + 1}`;
          return (
            <li key={r.key} className="grid gap-1.5 rounded-md border p-2">
              <div className="grid gap-1.5 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-center">
                <Input
                  aria-label={`Injector ${i + 1} name`}
                  placeholder="aws-sigv4"
                  value={r.name}
                  onChange={(e) => patch(r.key, { name: e.target.value })}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <Input
                  aria-label={`${label} hosts`}
                  placeholder="*.amazonaws.com"
                  value={r.hosts}
                  onChange={(e) => patch(r.key, { hosts: e.target.value })}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${label}`}
                  onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
                >
                  <XIcon />
                </Button>
              </div>
              <Textarea
                aria-label={`${label} code`}
                value={r.code}
                onChange={(e) => patch(r.key, { code: e.target.value })}
                spellCheck={false}
                placeholder={
                  "export default {\n  async fetch(request, env) {\n    return fetch(request);\n  },\n};"
                }
                className="max-h-96 min-h-28 font-mono text-xs"
              />
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        onClick={() => onChange([...rows, emptyInjectorRow()])}
      >
        <PlusIcon aria-hidden />
        Add injector
      </Button>
    </section>
  );
}
