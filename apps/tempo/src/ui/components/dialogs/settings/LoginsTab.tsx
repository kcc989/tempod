import type { CredentialProvider, CredentialStatus, FnOutput } from "@tempo/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { FileJsonIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Textarea } from "~/ui/components/ui/textarea";
import { invalidateCalls, useCallMutation } from "~/ui/hooks/useCall";
import { call } from "~/ui/lib/api";
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
    invalidates: ["getCredentialStatus", "listModels"],
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
    invalidates: ["getCredentialStatus", "listModels"],
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
  return (
    <div className="grid gap-3">
      <CodexDeviceLogin replacing={replacing} />
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Use auth.json instead</summary>
        <div className="pt-2">
          <CodexUploadForm row={row} replacing={replacing} />
        </div>
      </details>
    </div>
  );
}

export function CodexDeviceLogin({ replacing }: { replacing: boolean }) {
  const queryClient = useQueryClient();
  const [login, setLogin] = useState<FnOutput<"startCodexLogin"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const start = useCallMutation("startCodexLogin", {
    toast: false,
    onSuccess: (result) => {
      setError(null);
      setLogin(result);
    },
    onError: (e) => setError(errorText(e)),
  });

  useEffect(() => {
    if (!login || cancelling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result =
          Date.now() >= login.expiresAt
            ? { status: "expired" as const }
            : await call("pollCodexLogin", { loginId: login.loginId });
        if (stopped) return;
        if (result.status === "pending") {
          timer = setTimeout(() => void poll(), login.intervalMs);
          return;
        }
        setLogin(null);
        if (result.status === "connected") {
          forgetInvalid("codex");
          await invalidateCalls(queryClient, "getCredentialStatus");
          toast.success("Codex connected");
        } else setError("Codex login expired. Connect again to get a new code.");
      } catch (e) {
        if (!stopped) {
          setLogin(null);
          setError(errorText(e));
        }
      }
    };
    timer = setTimeout(() => void poll(), login.intervalMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [login, cancelling, queryClient]);

  const cancel = async () => {
    if (!login) return;
    setCancelling(true);
    try {
      await call("cancelCodexLogin", { loginId: login.loginId });
      setLogin(null);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        Sign in with ChatGPT using a one-time code. Enable device-code login in your ChatGPT security settings
        or ask your workspace admin.
      </p>
      {login ? (
        <>
          <p className="text-xs">Open the sign-in page, then enter this code:</p>
          <code className="text-lg tracking-widest" aria-label="Codex sign-in code">
            {login.userCode}
          </code>
          <div className="flex items-center gap-2">
            <Button asChild size="sm">
              <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">
                Open sign-in page
              </a>
            </Button>
            <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
          <p role="status" className="text-xs text-muted-foreground">
            Waiting for sign-in… This code expires in 15 minutes.
          </p>
        </>
      ) : (
        <Button
          size="sm"
          className="justify-self-start"
          disabled={start.isPending}
          onClick={() => {
            setError(null);
            start.mutate({});
          }}
        >
          {start.isPending ? "Connecting…" : replacing ? "Reconnect Codex" : "Connect Codex"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function CodexUploadForm({ row, replacing }: { row: LoginRow; replacing: boolean }) {
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState<{ readonly name: string; readonly text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = useCallMutation("setCodexAuth", {
    toast: false,
    invalidates: ["getCredentialStatus", "listModels"],
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
        Run <CommandLine>codex login</CommandLine>, then upload or paste{" "}
        <CommandLine>~/.codex/auth.json</CommandLine>.
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
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 px-1"
              onClick={() => setFile(null)}
            >
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
    invalidates: ["getCredentialStatus", "listModels"],
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
        if (!problem && isApiKeyProvider(row.provider))
          save.mutate({ provider: row.provider, key: key.trim() });
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
