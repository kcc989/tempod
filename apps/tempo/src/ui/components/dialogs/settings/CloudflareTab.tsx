import type { DeploySettings } from "@tempo/protocol";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { formatRelative } from "~/ui/lib/format";
import { errorCode, errorDetail, errorText, toastError } from "~/ui/lib/toast";

/** Settings → Cloudflare (12, Owner settings). The token is write-only. */
export function CloudflareTab() {
  const settings = useCallQuery("getDeploySettings", {});

  if (settings.isPending) return <SkeletonRows rows={3} />;

  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;

  return <CloudflareForm key={settings.data.updatedAt ?? 0} settings={settings.data} />;
}

function CloudflareForm({ settings }: { settings: DeploySettings }) {
  const [accountId, setAccountId] = useState(settings.accountId ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saved = settings.tokenSet || settings.accountId !== null;

  const save = useCallMutation("updateDeploySettings", {
    toast: false,
    invalidates: ["getDeploySettings"],
    onSuccess: () => {
      setToken("");
      setError(null);
      toast.success("Cloudflare account saved");
    },
    onError: (cause) => {
      const code = errorCode(cause);

      if (code === "DEPLOY_TOKEN_INVALID" || code === "VALIDATION_FAILED") {
        const detail = errorDetail(cause);
        setError(detail ? `${errorText(cause)} ${detail}` : errorText(cause));
      } else toastError(cause);
    },
  });

  const remove = useCallMutation("deleteDeploySettings", {
    invalidates: ["getDeploySettings"],
    onSuccess: () => {
      setError(null);
      toast.success("Cloudflare account removed");
    },
  });

  return (
    <section aria-label="Cloudflare" className="grid gap-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={settings.tokenSet ? "success" : "muted"}>
          {settings.tokenSet ? "Token set" : "No token"}
        </Badge>
        {settings.updatedAt !== null && (
          <span className="text-xs text-muted-foreground">Updated {formatRelative(settings.updatedAt)}</span>
        )}
        {saved && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate({})}
          >
            <Trash2Icon aria-hidden />
            Remove
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Deploys use this account. Tempo checks the token when you save. The token must be able to create
        account API tokens and must have the permissions that your deploy configurations use. Tempo never
        shows the token again.
      </p>
      <form
        className="grid gap-2"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ accountId: accountId.trim(), token: token.trim() });
        }}
      >
        <label htmlFor="cloudflare-account" className="text-xs text-muted-foreground">
          Account ID
        </label>
        <Input
          id="cloudflare-account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />
        <label htmlFor="cloudflare-token" className="text-xs text-muted-foreground">
          API token
        </label>
        <Input
          id="cloudflare-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={settings.tokenSet ? "Paste a new token to replace it" : "Paste the token"}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
        />
        <div className="flex flex-wrap items-center gap-2">
          {error && (
            <p role="alert" className="min-w-0 text-xs text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            size="sm"
            className="ml-auto"
            disabled={save.isPending || !accountId.trim() || !token.trim()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </section>
  );
}
