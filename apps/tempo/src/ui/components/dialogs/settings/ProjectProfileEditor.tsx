import type { ProjectProfile } from "@tempo/protocol";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/ui/components/ui/button";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { errorCode, errorDetail, errorText, toastError } from "~/ui/lib/toast";

const PLACEHOLDER = [
  "version: 1",
  "stack:",
  "  runtime: bun 1.3",
  "  frameworks: [TanStack Start, Effect v4]",
  "checks:",
  "  - name: typecheck",
  "    command: bun run typecheck",
  "screens:",
  "  - route: /",
  "    files: ['src/routes/index.tsx']",
].join("\n");

/** 13, L-ADR-3: the project profile every agent session gets. */
export function ProjectProfileEditor({ projectId }: { projectId: string }) {
  const profile = useCallQuery("getProjectProfile", { projectId });

  if (!profile.data) return null;

  return (
    <ProfileForm key={profile.data.revision} profile={profile.data} onReload={() => void profile.refetch()} />
  );
}

function ProfileForm({ profile, onReload }: { profile: ProjectProfile; onReload: () => void }) {
  const [source, setSource] = useState(profile.source);
  const [problem, setProblem] = useState<{ text: string; stale: boolean } | null>(null);

  const save = useCallMutation("updateProjectProfile", {
    toast: false,
    invalidates: ["getProjectProfile"],
    onSuccess: () => {
      setProblem(null);
      toast.success("Project profile saved");
    },
    onError: (cause) => {
      const code = errorCode(cause);

      if (code === "PROFILE_INVALID")
        setProblem({ text: errorDetail(cause) ?? errorText(cause), stale: false });
      else if (code === "PROFILE_CHANGED") setProblem({ text: errorText(cause), stale: true });
      else toastError(cause);
    },
  });

  return (
    <section aria-labelledby="ps-profile" className="grid gap-2 border-t pt-3">
      <h3 id="ps-profile" className="text-sm font-semibold">
        Project profile
      </h3>
      <p className="text-xs text-muted-foreground">
        The stack, services, checks and screens that every chat gets, so you never restate them. Name
        credentials, never paste their values.{" "}
        {profile.revision === 0 ? "Not saved yet." : `Revision ${profile.revision}.`}
      </p>
      <Textarea
        aria-label="Profile YAML"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        rows={12}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={PLACEHOLDER}
      />
      {problem && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          {problem.text}
          {problem.stale && (
            <Button size="sm" variant="outline" onClick={onReload}>
              Reload
            </Button>
          )}
        </div>
      )}
      <Button
        size="sm"
        className="justify-self-start"
        disabled={save.isPending || source === profile.source}
        onClick={() => save.mutate({ projectId: profile.projectId, source, revision: profile.revision })}
      >
        {save.isPending ? "Saving…" : "Save profile"}
      </Button>
    </section>
  );
}
