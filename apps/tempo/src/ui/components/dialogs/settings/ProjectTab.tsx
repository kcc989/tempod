import { DEFAULT_SETTINGS, type Environment, type Project, type WorkspaceDetail } from "@tempo/protocol";
import { FolderGit2Icon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useProjects } from "~/ui/hooks/useProjects";
import { errorCode, errorDetail, errorText, toastError } from "~/ui/lib/toast";
import { confirm, openDialog } from "~/ui/state/workspace-ui";
import { findEnvironment, NONE, policyLabel } from "../environments-model";
import { SubmitKbd } from "../parts";
import {
  FIELDS,
  formFromLayer,
  formSignature,
  isSecretName,
  layerFromForm,
  SECTIONS,
  sectionPage,
  type EffectiveContext,
  type FieldErrors,
  type FieldPath,
  type FieldState,
  type SettingsForm,
} from "../settings-model";
import { FieldRow } from "./ProjectFields";
import { useOpenWorkspaceDetail } from "./useOpenWorkspace";

/**
 * Settings → Project (04): every settings key with its effective value and where it came from,
 * the project's secrets, and Unlink. Values from repo files show while a workspace of the project
 * is open.
 */
export function ProjectTab({
  projectId,
  onProjectChange,
  section,
  onSectionChange,
}: {
  projectId: string | undefined;
  onProjectChange: (projectId: string) => void;
  section?: string;
  onSectionChange?: (section: string) => void;
}) {
  const projects = useProjects();
  const open = useOpenWorkspaceDetail();
  const envs = useCallQuery("listEnvironments", {});

  if (projects.isPending) return <SkeletonRows rows={8} />;
  if (projects.isError) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />;
  if (projects.data.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2Icon}
        title="Link a repo to start."
        action={<Button onClick={() => openDialog({ kind: "addProject" })}>Add project</Button>}
      />
    );
  }
  const list = projects.data;
  const project =
    list.find((p) => p.id === projectId) ?? list.find((p) => p.id === open?.projectId) ?? list[0]!;
  const workspace = open?.projectId === project.id ? open : null;
  const environment = findEnvironment(envs.data, project.environmentId);

  return (
    <div className="grid gap-5">
      {!section && list.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor="ps-project" className="text-sm font-medium">
            Project
          </label>
          <Select value={project.id} onValueChange={onProjectChange}>
            <SelectTrigger id="ps-project" className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {list.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.owner}/{p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div hidden={section !== undefined && section !== "Environment"}>
        <ProjectEnvironmentSelect
          project={project}
          environments={envs.data}
          environment={environment}
          loading={envs.isPending}
        />
      </div>
      <ProjectSettingsForm
        key={`${project.id}:${JSON.stringify(project.settings)}`}
        project={project}
        workspace={workspace}
        section={section}
        onSectionChange={onSectionChange}
        environment={environment}
      />
      <div hidden={section !== undefined && section !== "Secrets"}>
        <ProjectSecrets key={project.id} projectId={project.id} />
      </div>
      <div hidden={section !== undefined && section !== "General"}>
        <UnlinkProject project={project} />
      </div>
    </div>
  );
}

function ProjectSettingsForm({
  project,
  workspace,
  section,
  onSectionChange,
  environment,
}: {
  project: Project;
  workspace: WorkspaceDetail | null;
  section?: string;
  onSectionChange?: (section: string) => void;
  environment: Environment | null;
}) {
  const [initial] = useState(() => formFromLayer(project.settings, workspace?.settings ?? DEFAULT_SETTINGS));
  const [form, setForm] = useState<SettingsForm>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const initialSig = useMemo(() => formSignature(initial), [initial]);
  const dirty = formSignature(form) !== initialSig;

  const save = useCallMutation("updateProjectSettings", {
    toast: false,
    invalidates: ["listProjects"],
    onSuccess: () => toast.success("Project settings saved"),
    onError: (e) => {
      if (errorCode(e) !== "SETTINGS_INVALID") return toastError(e);
      const detail = errorDetail(e);
      setProblem(detail ? `${errorText(e)} ${detail}` : errorText(e));
    },
  });

  const ctx: EffectiveContext = {
    settings: workspace?.settings ?? null,
    sources: workspace?.settingsSources ?? null,
    layer: project.settings,
  };

  const change = (path: FieldPath, next: FieldState) => {
    setForm((f) => ({ ...f, [path]: next }));
    if (errors[path]) setErrors(({ [path]: _gone, ...rest }) => rest);
  };

  const submit = () => {
    const { layer, errors: found } = layerFromForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setProblem("Check the highlighted fields.");
      const invalid = FIELDS.find((field) => found[field.path]);
      if (invalid) onSectionChange?.(sectionPage(invalid.section));
      return;
    }
    setProblem(null);
    save.mutate({ projectId: project.id, settings: layer });
  };

  return (
    <form
      noValidate
      hidden={section === "Secrets" || section === "General"}
      aria-label={`Settings for ${project.owner}/${project.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-xs text-muted-foreground">
        {workspace
          ? `Values in effect for ${workspace.title}. Edit and save a value to override it in Tempo. Reset to inherited to use the repository or default value.`
          : "Open a workspace of this project to see values from its repo files. Edit and save a value to override it in Tempo. Reset to inherited to use the repository or default value."}
      </p>
      {SECTIONS.map((group) => (
        <fieldset
          key={group}
          hidden={section !== undefined && section !== sectionPage(group)}
          className="mt-6 border-t pt-4"
        >
          <legend className="pr-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {group}
          </legend>
          <div className="divide-y">
            {FIELDS.filter((d) => d.section === group).map((def) => (
              <FieldRow
                key={def.path}
                def={def}
                state={form[def.path]}
                onChange={(next) => change(def.path, next)}
                ctx={ctx}
                error={errors[def.path]}
                locked={environment ? lockedValue(def.path, environment) : undefined}
              />
            ))}
          </div>
        </fieldset>
      ))}
      <div className="sticky bottom-0 mt-2 flex flex-wrap items-center gap-2 border-t bg-background py-2">
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
            disabled={!dirty || save.isPending}
            onClick={() => {
              setForm(initial);
              setErrors({});
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

/** 04: egress policy and allowlist come from the project's environment while one is selected. */
const lockedValue = (path: string, env: Environment): { by: string; text: string } | undefined => {
  if (path === "environment.egress_policy") return { by: env.name, text: policyLabel(env.egressPolicy) };
  if (path === "environment.egress_allowlist")
    return { by: env.name, text: env.egressAllowlist.length > 0 ? env.egressAllowlist.join(", ") : "None" };
  return undefined;
};

/** 04, Project → Environment: the Environment select, saved at once with setProjectEnvironment. */
function ProjectEnvironmentSelect({
  project,
  environments,
  environment,
  loading,
}: {
  project: Project;
  environments: ReadonlyArray<Environment> | undefined;
  environment: Environment | null;
  loading: boolean;
}) {
  const set = useCallMutation("setProjectEnvironment", {
    invalidates: ["listProjects"],
    onSuccess: (p) => {
      const name = findEnvironment(environments, p.environmentId)?.name;
      toast.success(name ? `${project.owner}/${project.name} uses ${name}` : "Environment removed");
    },
  });
  return (
    <div className="grid gap-1.5">
      <label htmlFor="ps-environment" className="text-sm font-medium">
        Environment
      </label>
      <Select
        value={environment?.id ?? NONE}
        disabled={loading || set.isPending}
        onValueChange={(v) => set.mutate({ projectId: project.id, environmentId: v === NONE ? null : v })}
      >
        <SelectTrigger id="ps-environment" className="w-72 max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>None</SelectItem>
          {environments?.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Egress rules, secrets and injectors for this project's workspaces. Saved at once.{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => openDialog({ kind: "settings", tab: "environments" })}
        >
          Manage environments
        </button>
      </p>
    </div>
  );
}

function ProjectSecrets({ projectId }: { projectId: string }) {
  const names = useCallQuery("listProjectSecretNames", { projectId });
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const set = useCallMutation("setProjectSecret", {
    toast: false,
    invalidates: ["listProjectSecretNames"],
    onSuccess: (_, input) => {
      setName("");
      setValue("");
      setError(null);
      toast.success(`${input.name} saved`);
    },
    onError: (e) => (errorCode(e) === "VALIDATION_FAILED" ? setError(errorText(e)) : toastError(e)),
  });
  const remove = useCallMutation("deleteProjectSecret", {
    invalidates: ["listProjectSecretNames"],
    onSuccess: (_, input) => toast.success(`${input.name} deleted`),
  });
  const existing = names.data?.names ?? [];
  const trimmed = name.trim();

  return (
    <section aria-labelledby="ps-secrets" className="grid gap-2 border-t pt-3">
      <h3 id="ps-secrets" className="text-sm font-semibold">
        Secrets
      </h3>
      <p className="text-xs text-muted-foreground">
        Added to the environment of scripts and agents. Values are never shown again.
      </p>
      {names.isPending ? (
        <SkeletonRows rows={2} />
      ) : names.isError ? (
        <ErrorState error={names.error} onRetry={() => void names.refetch()} />
      ) : existing.length === 0 ? (
        <p className="text-xs text-muted-foreground">No secrets.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {existing.map((n) => (
            <li key={n} className="flex items-center gap-2 px-2 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{n}</span>
              <span className="text-xs text-muted-foreground">Set</span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete ${n}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate({ projectId, name: n })}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-1.5"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isSecretName(trimmed)) {
            setError("Use capital letters, digits and _, starting with a letter or _.");
            return;
          }
          if (value === "") {
            setError("Enter a value.");
            return;
          }
          setError(null);
          set.mutate({ projectId, name: trimmed, value });
        }}
      >
        <div className="grid grid-cols-[10rem_minmax(0,1fr)_auto] gap-1.5">
          <Input
            aria-label="Secret name"
            placeholder="API_TOKEN"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error && !isSecretName(trimmed) ? true : undefined}
            className="font-mono text-xs"
          />
          <Input
            aria-label="Secret value"
            type="password"
            placeholder="Value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" size="sm" variant="outline" disabled={set.isPending}>
            {existing.includes(trimmed) ? "Replace" : "Add"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function UnlinkProject({ project }: { project: Project }) {
  const unlink = useCallMutation("unlinkProject", {
    invalidates: ["listProjects", "listWorkspaces"],
    onSuccess: () => toast.success(`Unlinked ${project.owner}/${project.name}`),
  });
  return (
    <section aria-labelledby="ps-unlink" className="grid gap-2 border-t pt-3">
      <h3 id="ps-unlink" className="text-sm font-semibold">
        Unlink project
      </h3>
      <p className="text-xs text-muted-foreground">
        Archive its workspaces first. Its archived workspaces and secrets are deleted; the repo on GitHub
        stays as it is.
      </p>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        className="w-fit"
        disabled={unlink.isPending}
        onClick={async () => {
          const ok = await confirm({
            title: `Unlink ${project.owner}/${project.name}?`,
            description: "Its archived workspaces and secrets are deleted.",
            confirmLabel: "Unlink",
            destructive: true,
          });
          if (ok) unlink.mutate({ projectId: project.id });
        }}
      >
        Unlink
      </Button>
    </section>
  );
}
