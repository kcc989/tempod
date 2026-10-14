import {
  DOTFILES_LIMITS,
  dotfilesProblem,
  isDotfilePath,
  type Dotfile,
  type DotfilesState,
} from "@tempo/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Textarea } from "~/ui/components/ui/textarea";
import { callKey, useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { errorCode, errorDetail, errorText, toastError } from "~/ui/lib/toast";
import { cn } from "~/ui/lib/utils";
import { SubmitKbd } from "../parts";

const signature = (files: ReadonlyArray<Dotfile>) => JSON.stringify(files.map((f) => [f.path, f.content]));

type Problem = { text: string; reload: boolean };

/** Settings → Shell (04): the owner's shell files (01, Shell and dotfiles). */
export function ShellTab() {
  const dotfiles = useCallQuery("getDotfiles", {}, { refetchOnWindowFocus: false });
  const [version, setVersion] = useState(0);

  if (dotfiles.isPending) return <SkeletonRows rows={6} />;

  if (dotfiles.isError) return <ErrorState error={dotfiles.error} onRetry={() => void dotfiles.refetch()} />;

  return (
    <ShellEditor
      key={version}
      state={dotfiles.data}
      onSaved={() => setVersion((v) => v + 1)}
      onReload={async () => {
        await dotfiles.refetch();
        setVersion((v) => v + 1);
      }}
    />
  );
}

function ShellEditor({
  state,
  onSaved,
  onReload,
}: {
  state: DotfilesState;
  onSaved: () => void;
  onReload: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<ReadonlyArray<Dotfile>>(state.files);
  const [selected, setSelected] = useState<string | null>(state.files[0]?.path ?? null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [reloading, setReloading] = useState(false);
  const dirty = signature(files) !== signature(state.files);
  const current = files.find((f) => f.path === selected) ?? files[0];

  const save = useCallMutation("updateDotfiles", {
    toast: false,
    onSuccess: (next) => {
      queryClient.setQueryData(callKey("getDotfiles", {}), next);
      toast.success("Shell files saved");
      onSaved();
    },
    onError: (e) => {
      const code = errorCode(e);

      if (code === "DOTFILES_CHANGED") return setProblem({ text: errorText(e), reload: true });

      if (code !== "VALIDATION_FAILED") return toastError(e);
      const detail = errorDetail(e);
      setProblem({ text: detail ? `${errorText(e)} ${detail}` : errorText(e), reload: false });
    },
  });

  const replace = (next: ReadonlyArray<Dotfile>) => {
    setFiles(next);
    setProblem(null);
  };

  const submit = () => {
    const found = dotfilesProblem(files);

    if (found) return setProblem({ text: found, reload: false });
    setProblem(null);
    save.mutate({ files });
  };

  return (
    <form
      noValidate
      autoComplete="off"
      aria-label="Shell files"
      className="grid min-w-0 gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Terminals use zsh. Changes apply when a workspace starts or wakes. Don't put secrets here; use
        Environments.
      </p>
      <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          {files.length > 0 && (
            <ul aria-label="Files" className="grid gap-0.5">
              {files.map((f) => (
                <li key={f.path} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-current={f.path === current?.path ? "true" : undefined}
                    onClick={() => setSelected(f.path)}
                    title={f.path}
                    className={cn(
                      "min-h-7 min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      f.path === current?.path && "bg-accent font-medium text-accent-foreground",
                    )}
                  >
                    {f.path}
                  </button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${f.path}`}
                    onClick={() => replace(files.filter((x) => x.path !== f.path))}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <AddFile
            files={files}
            onAdd={(path) => {
              replace([...files, { path, content: "" }]);
              setSelected(path);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-fit"
            disabled={save.isPending}
            onClick={() => {
              replace(state.defaults);
              setSelected(state.defaults[0]?.path ?? null);
            }}
          >
            Reset to defaults
          </Button>
        </div>
        {current ? (
          <Textarea
            aria-label={current.path}
            value={current.content}
            onChange={(e) =>
              setFiles(files.map((f) => (f.path === current.path ? { ...f, content: e.target.value } : f)))
            }
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            className="h-[max(20rem,calc(100dvh-24rem))] resize-none overflow-auto font-mono text-xs [field-sizing:fixed]"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No shell files. Workspaces use the image defaults.</p>
        )}
      </div>
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-background py-2">
        {problem && (
          <div role="alert" className="flex min-w-0 flex-1 items-center gap-2 text-xs text-destructive">
            <p className="min-w-0">{problem.text}</p>
            {problem.reload && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={reloading}
                onClick={async () => {
                  setReloading(true);

                  try {
                    await onReload();
                  } finally {
                    setReloading(false);
                  }
                }}
              >
                Reload
              </Button>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setFiles(state.files);
              setProblem(null);
            }}
          >
            Reset
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
            <SubmitKbd className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground" />
          </Button>
        </div>
      </div>
    </form>
  );
}

function AddFile({ files, onAdd }: { files: ReadonlyArray<Dotfile>; onAdd: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = files.length >= DOTFILES_LIMITS.filesMax;

  const close = () => {
    setOpen(false);
    setPath("");
    setError(null);
  };

  const add = () => {
    const p = path.trim();

    if (!isDotfilePath(p)) {
      return setError(
        "Enter a path in your home folder, such as .gitconfig. Tempo and agent folders such as .ssh and .claude are not allowed.",
      );
    }

    const conflict = dotfilesProblem([
      ...files.map((f) => ({ path: f.path, content: "" })),
      { path: p, content: "" },
    ]);

    if (conflict) return setError(conflict);
    onAdd(p);
    close();
  };

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        disabled={full}
        title={full ? `Up to ${DOTFILES_LIMITS.filesMax} files` : undefined}
        onClick={() => setOpen(true)}
      >
        <PlusIcon aria-hidden />
        Add file
      </Button>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Input
        aria-label="New file path"
        placeholder=".gitconfig"
        autoFocus
        maxLength={DOTFILES_LIMITS.pathMax}
        spellCheck={false}
        value={path}
        onChange={(e) => {
          setPath(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.code === "Enter" && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            add();
          }

          if (e.code === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "shell-add-error" : undefined}
        className="font-mono text-xs"
      />
      {error && (
        <p id="shell-add-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button type="button" size="sm" onClick={add}>
          Add
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
