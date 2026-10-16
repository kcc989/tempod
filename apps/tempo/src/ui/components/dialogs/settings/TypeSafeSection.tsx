import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { formatRelative } from "~/ui/lib/format";
import { errorCode, errorDetail, errorText, toastError } from "~/ui/lib/toast";

/** Settings → TypeSafe AI (13, L-ADR-9). The key is write-only. */
export function TypeSafeSection() {
  const settings = useCallQuery("getJudgeSettings", {});
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useCallMutation("setJudgeKey", {
    toast: false,
    invalidates: ["getJudgeSettings"],
    onSuccess: () => {
      setKey("");
      setError(null);
      toast.success("TypeSafe AI key saved");
    },
    onError: (cause) => {
      if (errorCode(cause) === "VALIDATION_FAILED") setError(errorDetail(cause) ?? errorText(cause));
      else toastError(cause);
    },
  });

  const remove = useCallMutation("deleteJudgeKey", {
    invalidates: ["getJudgeSettings"],
    onSuccess: () => toast.success("TypeSafe AI key removed"),
  });

  if (!settings.data) return null;
  const { keySet, updatedAt } = settings.data;

  return (
    <section aria-label="TypeSafe AI" className="grid gap-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">TypeSafe AI</span>
        <Badge variant={keySet ? "success" : "muted"}>{keySet ? "Key set" : "No key"}</Badge>
        {updatedAt !== null && (
          <span className="text-xs text-muted-foreground">Updated {formatRelative(updatedAt)}</span>
        )}
        {keySet && (
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
        Jev judges each new task's risk and each Cloudflare call an agent makes. Without a key, you confirm
        every intent yourself. Tempo checks the key when you save and never shows it again.
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ key: key.trim() });
        }}
      >
        <label htmlFor="typesafe-key" className="sr-only">
          TypeSafe AI key
        </label>
        <Input
          id="typesafe-key"
          type="password"
          className="min-w-0 flex-1"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={keySet ? "Paste a new key to replace it" : "Paste the key"}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
        />
        <Button type="submit" size="sm" disabled={save.isPending || !key.trim()}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {error && (
          <p role="alert" className="w-full text-xs text-destructive">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
