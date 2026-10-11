import type { CredentialProvider, CredentialStatus } from "@tempo/protocol";
import { FileJsonIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { formatRelative } from "~/ui/lib/format";
import { errorCode, errorDetail, errorText, toastError } from "~/ui/lib/toast";
import { openWorkspaceStores } from "~/ui/stores/workspace-store";
import {
  checkApiKey,
  checkClaudeToken,
  checkCodexAuth,
  isApiKeyProvider,
  LOGIN_ROWS,
  loginState,
  MAX_AUTH_JSON_BYTES,
  type LoginRow,
} from "../credentials-model";
import { CommandLine } from "../parts";

/** Settings → Logins (04). Values are write-only: once saved they are never shown again. */
export function LoginsTab() {
  const status = useCredentialStatus();
  if (status.isPending) return <SkeletonRows rows={6} />;
  if (status.isError) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Each agent needs a login or an API key. Saved values are never shown again.
      </p>
      {LOGIN_ROWS.map((row) => (
        <LoginCard key={row.provider} row={row} status={status.data} />
      ))}
    </div>
  );
}

const forgetInvalid = (provider: CredentialProvider) => {
  for (const store of openWorkspaceStores()) store.clearCredentialInvalid([provider]);
};

/** Server-side validation shows next to the field; other errors toast. */
const inlineOrToast = (e: unknown, setError: (s: string) => void) => {
  if (errorCode(e) === "VALIDATION_FAILED") {
    const detail = errorDetail(e);
    setError(detail ? `${errorText(e)} ${detail}` : errorText(e));
  } else toastError(e);
};

function LoginCard({ row, status }: { row: LoginRow; status: CredentialStatus }) {
  const state = loginState(status, row.provider);
  const remove = useCallMutation("deleteCredential", {
    invalidates: ["getCredentialStatus"],
    onSuccess: () => toast.success(`${row.label} removed`),
  });
  const lastRefresh = row.provider === "codex" ? status.codex.lastRefresh : null;

  return (
    <section aria-label={row.label} className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{row.label}</h3>
        <Badge variant={state.set ? "success" : "muted"}>{state.set ? "Set" : "Not set"}</Badge>
        <span className="text-xs text-muted-foreground">
          {state.updated}
          {lastRefresh ? ` · token refreshed ${formatRelative(lastRefresh)}` : ""}
        </span>
        {state.set && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            disabled={remove.isPending}
            aria-label={`Remove ${row.label}`}
            onClick={() => remove.mutate({ key: row.key })}
          >
            <Trash2Icon aria-hidden />
            Remove
          </Button>
        )}
      </div>
      {row.kind === "claudeToken" && <ClaudeForm row={row} replacing={state.set} />}
      {row.kind === "codexAuth" && <CodexForm row={row} replacing={state.set} />}
      {row.kind === "apiKey" && <ApiKeyForm row={row} replacing={state.set} />}
    </section>
  );
}

function SecretForm({
  onSubmit,
  error,
  children,
  submitLabel,
  pending,
}: {
  onSubmit: () => void;
  error: string | null;
  children: ReactNode;
  submitLabel: string;
  pending: boolean;
}) {
  return (
    <form
      className="grid gap-1.5"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <div className="flex items-center gap-2">
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" size="sm" className="ml-auto" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function ClaudeForm({ row, replacing }: { row: LoginRow; replacing: boolean }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useCallMutation("setClaudeToken", {
    toast: false,
    invalidates: ["getCredentialStatus"],
    onSuccess: () => {
      setToken("");
      setError(null);
      forgetInvalid(row.provider);
      toast.success("Claude login saved");
    },
    onError: (e) => inlineOrToast(e, setError),
  });
  const id = `login-${row.provider}`;
  return (
    <SecretForm
      error={error}
      pending={save.isPending}
      submitLabel={replacing ? "Replace" : "Save"}
      onSubmit={() => {
        const problem = checkClaudeToken(token);
        setError(problem);
        if (!problem) save.mutate({ token: token.trim() });
      }}
    >
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Run <CommandLine>claude setup-token</CommandLine> and paste the token it prints.
      </label>
      <Input
        id={id}
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={replacing ? "Paste a new token to replace it" : "Paste the token"}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
      />
    </SecretForm>
  );
}

function CodexForm({ row, replacing }: { row: LoginRow; replacing: boolean }) {
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState<{ readonly name: string; readonly text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = useCallMutation("setCodexAuth", {
    toast: false,
    invalidates: ["getCredentialStatus"],
    onSuccess: () => {
      setPasted("");
      setFile(null);
      setError(null);
      forgetInvalid(row.provider);
      toast.success("Codex login saved");
    },
    onError: (e) => inlineOrToast(e, setError),
  });
  const id = `login-${row.provider}`;

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_AUTH_JSON_BYTES) {
      setError("That file is too big for an auth.json.");
      return;
    }
    const text = await f.text();
    setPasted("");
    setFile({ name: f.name, text });
    setError(checkCodexAuth(text));
  };

  return (
    <SecretForm
      error={error}
      pending={save.isPending}
      submitLabel={replacing ? "Replace" : "Save"}
      onSubmit={() => {
        const text = file?.text ?? pasted;
        const problem = checkCodexAuth(text);
        setError(problem);
        if (!problem) save.mutate({ authJson: text });
      }}
    >
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Run <CommandLine>codex login</CommandLine>, then upload or paste <CommandLine>~/.codex/auth.json</CommandLine>.
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            void readFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button type="button" size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
          <UploadIcon aria-hidden />
          Upload auth.json
        </Button>
        {file && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <FileJsonIcon aria-hidden className="size-3" />
            {file.name} ready to save
            <Button type="button" size="sm" variant="ghost" className="h-5 px-1" onClick={() => setFile(null)}>
              Clear
            </Button>
          </span>
        )}
      </div>
      {!file && (
        <Textarea
          id={id}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Or paste auth.json here"
          spellCheck={false}
          autoComplete="off"
          className="max-h-32 min-h-14 font-mono text-xs"
          aria-invalid={error ? true : undefined}
        />
      )}
    </SecretForm>
  );
}

function ApiKeyForm({ row, replacing }: { row: LoginRow; replacing: boolean }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useCallMutation("setApiKey", {
    toast: false,
    invalidates: ["getCredentialStatus"],
    onSuccess: () => {
      setKey("");
      setError(null);
      forgetInvalid(row.provider);
      toast.success(`${row.label} saved`);
    },
    onError: (e) => inlineOrToast(e, setError),
  });
  const id = `login-${row.provider}`;
  return (
    <SecretForm
      error={error}
      pending={save.isPending}
      submitLabel={replacing ? "Replace" : "Save"}
      onSubmit={() => {
        const problem = checkApiKey(key);
        setError(problem);
        if (!problem && isApiKeyProvider(row.provider)) save.mutate({ provider: row.provider, key: key.trim() });
      }}
    >
      <label htmlFor={id} className="sr-only">
        {row.label}
      </label>
      <Input
        id={id}
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={replacing ? "Paste a new key to replace it" : "Paste the key"}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
      />
    </SecretForm>
  );
}
