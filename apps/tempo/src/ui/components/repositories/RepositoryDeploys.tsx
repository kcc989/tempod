import {
  PERMISSION_GROUPS,
  TempoError,
  type DeployConfig,
  type Deployment,
  type Project,
} from "@tempo/protocol";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CloudUploadIcon, RocketIcon } from "lucide-react";
import { useState } from "react";
import { BranchPicker } from "~/ui/components/dialogs/BranchPicker";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { formatRelative, formatTime } from "~/ui/lib/format";
import { errorCode, errorText } from "~/ui/lib/toast";
import { openDialog } from "~/ui/state/workspace-ui";
import { permissionText } from "~/ui/components/chat/transcript-model";
import type { RepositoryHubProps } from "./RepositoryHub";
import {
  ROLLOUT_PHASE_LABELS,
  canRollBack,
  ciDuration,
  deployInput,
  deploymentsInput,
  deployState,
  shortSha,
} from "./model";

type Props = RepositoryHubProps & { project: Project };

const LIVE_MS = 5_000;

const PAGE = 50;

const ALL_TARGETS = "all-targets";

/** 12, Clients: deployments, deployment detail with its log, and the owner configuration. */
export function RepositoryDeploys(props: Props) {
  if (props.search.deployment) return <DeploymentDetail {...props} deploymentId={props.search.deployment} />;

  return <DeploysHome {...props} />;
}

function StateBadge({ item }: { item: Pick<Deployment, "status" | "conclusion"> }) {
  const state = deployState(item);

  return <Badge variant={state.tone}>{state.label}</Badge>;
}

function DeploysHome(props: Props) {
  const config = useCallQuery("getDeployConfig", { projectId: props.project.id });

  return (
    <div className="flex flex-col gap-6 p-5">
      {config.isPending ? (
        <SkeletonRows rows={4} />
      ) : config.isError ? (
        <ErrorState error={config.error} onRetry={() => void config.refetch()} />
      ) : (
        <>
          <DeployAction {...props} config={config.data} />
          <ProductionErrors projectId={props.project.id} />
          <Deployments {...props} config={config.data} />
          <ConfigForm
            key={config.data.revision}
            config={config.data}
            onReload={() => void config.refetch()}
          />
          <CloudflareGrants projectId={props.project.id} />
          <IssuesWebhook projectId={props.project.id} />
        </>
      )}
    </div>
  );
}

function DeployAction({ project, onNavigate, config }: Props & { config: DeployConfig }) {
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ text: string; settings: boolean } | null>(null);
  const target = config.targets.find((item) => item.key === targetKey);
  const input = deployInput(project.id, target, branch);

  const start = useCallMutation("startDeployment", {
    toast: false,
    invalidates: ["listDeployments"],
    onSuccess: (deployment) => onNavigate({ project: project.id, tab: "deploys", deployment: deployment.id }),
    onError: (error) =>
      setProblem({ text: errorText(error), settings: errorCode(error) === "DEPLOY_ACCOUNT_NOT_SET" }),
  });

  return (
    <section className="flex flex-col gap-2" aria-label="Deploy">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={targetKey ?? ""}
          onValueChange={(value) => {
            setTargetKey(value);
            setProblem(null);
          }}
          disabled={config.targets.length === 0}
        >
          <SelectTrigger aria-label="Target to deploy" className="w-full sm:w-48">
            <SelectValue placeholder="Pick a target" />
          </SelectTrigger>
          <SelectContent>
            {config.targets.map((item) => (
              <SelectItem key={item.key} value={item.key}>
                {item.key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {target &&
          (target.branch === null ? (
            <div className="w-full sm:w-56">
              <BranchPicker
                id="deploy-branch"
                label="Branch to deploy"
                placeholder="Pick a branch"
                projectId={project.id}
                value={branch}
                onChange={(value) => {
                  setBranch(value);
                  setProblem(null);
                }}
              />
            </div>
          ) : (
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              Deploys branch <code className="font-mono text-xs">{target.branch}</code>
            </span>
          ))}
        <Button
          size="sm"
          className="sm:ml-auto"
          disabled={!input || start.isPending}
          onClick={() => input && start.mutate(input)}
        >
          <RocketIcon />
          {start.isPending ? "Deploying…" : "Deploy"}
        </Button>
      </div>
      {config.targets.length === 0 && (
        <p className="text-sm text-muted-foreground">Add targets in the configuration below to deploy.</p>
      )}
      {problem && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {problem.text}
          {problem.settings && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openDialog({ kind: "settings", tab: "cloudflare" })}
            >
              Open settings
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function Deployments({ project, onNavigate, config }: Props & { config: DeployConfig }) {
  const [target, setTarget] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const deployments = useCallQuery("listDeployments", deploymentsInput(project.id, target, offset), {
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status !== "completed") ? LIVE_MS : false,
  });

  return (
    <section className="flex flex-col gap-4" aria-label="Deployments">
      <Select
        value={target ?? ALL_TARGETS}
        onValueChange={(value) => {
          setTarget(value === ALL_TARGETS ? null : value);
          setOffset(0);
        }}
      >
        <SelectTrigger aria-label="Filter deployments by target" className="w-full sm:w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_TARGETS}>All targets</SelectItem>
          {config.targets.map((item) => (
            <SelectItem key={item.key} value={item.key}>
              {item.key}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {deployments.isPending ? (
        <SkeletonRows rows={4} />
      ) : deployments.isError ? (
        <ErrorState error={deployments.error} onRetry={() => void deployments.refetch()} />
      ) : deployments.data.length === 0 ? (
        <EmptyState
          icon={CloudUploadIcon}
          title={offset > 0 ? "No older deployments." : "No deployments yet."}
          description="Save a configuration below, then deploy a target."
        />
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Deployment list">
          {deployments.data.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30"
                onClick={() => onNavigate({ project: project.id, tab: "deploys", deployment: item.id })}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    #{item.number} · {item.target}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {item.stage} · {item.branch} · {shortSha(item.sha)} · {item.trigger} ·{" "}
                    {formatRelative(item.createdAt)}
                  </p>
                </div>
                <StateBadge item={item} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {offset > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Newer deployments
          </Button>
        )}
        {deployments.data?.length === PAGE && (
          <Button size="sm" variant="ghost" onClick={() => setOffset(offset + PAGE)}>
            Older deployments
          </Button>
        )}
      </div>
    </section>
  );
}

function DeploymentDetail({ project, onNavigate, deploymentId }: Props & { deploymentId: string }) {
  const detail = useCallQuery(
    "getDeployment",
    { projectId: project.id, deploymentId },
    { refetchInterval: (query) => (query.state.data?.status === "completed" ? false : LIVE_MS) },
  );

  const cancel = useCallMutation("cancelDeployment", { invalidates: ["getDeployment", "listDeployments"] });

  const rollback = useCallMutation("rollbackDeployment", {
    invalidates: ["getDeployment", "listDeployments"],
  });

  const again = useCallMutation("redeploy", {
    invalidates: ["listDeployments"],
    onSuccess: (deployment) => onNavigate({ project: project.id, tab: "deploys", deployment: deployment.id }),
  });

  const back = (
    <Button
      variant="ghost"
      size="sm"
      className="self-start"
      onClick={() => onNavigate({ project: project.id, tab: "deploys" })}
    >
      <ArrowLeftIcon />
      Deployments
    </Button>
  );

  if (detail.isPending)
    return (
      <div className="flex flex-col gap-4 p-5">
        {back}
        <SkeletonRows rows={4} />
      </div>
    );

  if (detail.isError)
    return (
      <div className="flex flex-col gap-4 p-5">
        {back}
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  const deployment = detail.data;
  const state = deployState(deployment);

  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Status", deployment.status === "completed" ? "Completed" : state.label],
    ["Conclusion", deployment.status === "completed" ? state.label : "None yet"],
    ["Exit code", deployment.exitCode === null ? "None" : String(deployment.exitCode)],
    ["Duration", ciDuration(deployment.startedAt, deployment.completedAt) || "Not started"],
    ["Trigger", deployment.trigger],
    ["Summary", deployment.summary ?? "None"],
  ];

  return (
    <div className="flex flex-col gap-4 p-5">
      {back}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 text-xl font-semibold">
          Deployment #{deployment.number} <span className="text-muted-foreground">{deployment.target}</span>
        </h2>
        <StateBadge item={deployment} />
        <span className="min-w-0 break-all text-sm text-muted-foreground">
          {deployment.stage} · {deployment.branch} · {shortSha(deployment.sha)} · configuration revision{" "}
          {deployment.revision}
        </span>
        <span className="ml-auto flex gap-2">
          {canRollBack(deployment) && (
            <Button
              size="sm"
              variant="outline"
              disabled={rollback.isPending}
              onClick={() => rollback.mutate({ projectId: project.id, deploymentId: deployment.id })}
            >
              Roll back
            </Button>
          )}
          {deployment.status === "completed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={again.isPending}
              onClick={() => again.mutate({ projectId: project.id, deploymentId: deployment.id })}
            >
              Redeploy
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ projectId: project.id, deploymentId: deployment.id })}
            >
              Cancel
            </Button>
          )}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border p-4 text-sm">
        {facts.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {deployment.rollout && <RolloutFacts rollout={deployment.rollout} />}
      <DeploymentLog
        projectId={project.id}
        deploymentId={deployment.id}
        live={deployment.status === "running"}
      />
    </div>
  );
}

function DeploymentLog({
  projectId,
  deploymentId,
  live,
}: {
  projectId: string;
  deploymentId: string;
  live: boolean;
}) {
  const log = useCallQuery(
    "getDeploymentLog",
    { projectId, deploymentId },
    { refetchInterval: live ? LIVE_MS : false },
  );

  return (
    <section aria-label="Deployment log" className="rounded-lg border">
      <p className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
        Log{log.data?.truncated ? " (last 1 MiB)" : ""}
      </p>
      {log.isPending ? (
        <SkeletonRows rows={3} />
      ) : log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : (
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs">
          {log.data.text || "No output yet."}
        </pre>
      )}
    </section>
  );
}

function ConfigForm({ config, onReload }: { config: DeployConfig; onReload: () => void }) {
  const [source, setSource] = useState(config.source);
  const [problem, setProblem] = useState<{ text: string; stale: boolean } | null>(null);

  const save = useCallMutation("updateDeployConfig", {
    toast: false,
    invalidates: ["getDeployConfig"],
    onSuccess: () => setProblem(null),
    onError: (error) => {
      if (error instanceof TempoError && error.code === "DEPLOY_CONFIG_INVALID")
        setProblem({ text: error.detail ?? error.message, stale: false });
      else if (error instanceof TempoError && error.code === "DEPLOY_CONFIG_CHANGED")
        setProblem({ text: error.message, stale: true });
      else setProblem({ text: error.message, stale: false });
    },
  });

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Configuration">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="deploy-config" className="text-base font-semibold">
          Configuration
        </Label>
        <Badge variant={config.enabled ? "success" : "muted"}>{config.enabled ? "Enabled" : "Off"}</Badge>
        <span className="min-w-0 text-xs text-muted-foreground">
          {config.revision === 0 ? "Not saved yet" : `Revision ${config.revision}`}
          {config.targets.length ? ` · targets ${config.targets.map((item) => item.key).join(", ")}` : ""}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        YAML with <code>version: 1</code>, <code>tool</code> and <code>targets</code>. Only you can change it;
        a branch cannot. Leave it empty to turn deploys off.
      </p>
      <Textarea
        id="deploy-config"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        rows={12}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={"version: 1\ntool: alchemy\ntargets:\n  production:\n    branch: main"}
      />
      {problem && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
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
        className="self-start"
        disabled={save.isPending || source === config.source}
        onClick={() => save.mutate({ projectId: config.projectId, source, revision: config.revision })}
      >
        {save.isPending ? "Saving…" : "Save configuration"}
      </Button>
    </section>
  );
}

function RolloutFacts({ rollout }: { rollout: NonNullable<Deployment["rollout"]> }) {
  return (
    <section aria-label="Rollout" className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
      <p className="font-medium">
        {ROLLOUT_PHASE_LABELS[rollout.phase]}
        {rollout.phase === "canary" && rollout.canaryUntil !== null && (
          <span className="font-normal text-muted-foreground">
            {" "}
            · moves to 100% at {formatTime(rollout.canaryUntil)}
          </span>
        )}
        {rollout.rolledBackAt !== null && (
          <span className="font-normal text-muted-foreground"> · {formatRelative(rollout.rolledBackAt)}</span>
        )}
      </p>
      <ul className="flex flex-col gap-2">
        {rollout.workers.map((w) => (
          <li key={w.name} className="min-w-0">
            <p className="font-mono text-xs">
              {w.name} · {w.percentage}%
            </p>
            <p className="break-all font-mono text-xs text-muted-foreground">
              version {w.versionId} · previous {w.previousVersionId ?? "none"} · Cloudflare deployment{" "}
              {w.cloudflareDeploymentId ?? "none"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 12, Production errors: Clients. */
function ProductionErrors({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const errors = useCallQuery("listProductionErrors", { projectId }, { refetchInterval: LIVE_MS });

  const fix = useCallMutation("startErrorFix", {
    invalidates: ["listProductionErrors"],
    onSuccess: ({ workspaceId }) => void navigate({ to: "/w/$workspaceId", params: { workspaceId } }),
  });

  if (errors.isPending || errors.isError || errors.data.length === 0) return null;

  return (
    <section aria-label="Production errors" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">Production errors</h3>
      <ul className="flex flex-col divide-y rounded-lg border">
        {errors.data.map((error) => (
          <li
            key={error.id}
            className={`flex flex-wrap items-center gap-3 px-4 py-3 ${error.fixedAt !== null ? "opacity-60" : ""}`}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{error.title}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {error.worker ?? "Unknown Worker"} · version {error.versionId ?? "unknown"} ·{" "}
                {error.occurrences} {error.occurrences === 1 ? "time" : "times"} · last{" "}
                {formatRelative(error.lastSeenAt)}
                {error.fixedAt !== null ? " · Fixed" : ""}
              </p>
            </div>
            {error.fixWorkspaceId !== null ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void navigate({ to: "/w/$workspaceId", params: { workspaceId: error.fixWorkspaceId! } })
                }
              >
                Open fix
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={fix.isPending}
                onClick={() => fix.mutate({ projectId, errorId: error.id })}
              >
                Start fix
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function IssuesWebhook({ projectId }: { projectId: string }) {
  const hook = useCallQuery("getIssuesWebhook", { projectId });
  const [secret, setSecret] = useState<string | null>(null);

  const rotate = useCallMutation("rotateIssuesWebhook", {
    invalidates: ["getIssuesWebhook"],
    onSuccess: (out) => setSecret(out.secret),
  });

  if (hook.isPending || hook.isError) return null;

  return (
    <section
      aria-label="Production error webhook"
      className="flex flex-col gap-2 rounded-lg border p-4 text-sm"
    >
      <p className="text-base font-semibold">Production error webhook</p>
      <p className="text-muted-foreground">
        In Cloudflare, add a generic webhook destination with this URL and secret, and an Issues automation
        that sends new issues to it.
      </p>
      <p className="break-all font-mono text-xs">{hook.data.url}</p>
      <p className="text-muted-foreground">{hook.data.secretSet ? "A secret is set." : "No secret yet."}</p>
      {secret !== null && (
        <p role="status" className="break-all font-mono text-xs">
          Secret (shown once): {secret}
        </p>
      )}
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={rotate.isPending}
        onClick={() => rotate.mutate({ projectId })}
      >
        New secret
      </Button>
    </section>
  );
}

/** 12, Access requests and grants: what deploys and agents may do in Cloudflare. */
function CloudflareGrants({ projectId }: { projectId: string }) {
  const grants = useCallQuery("listCloudflareGrants", { projectId });

  const remove = useCallMutation("removeCloudflareGrant", {
    invalidates: ["listCloudflareGrants", "getDeployConfig"],
  });

  if (grants.isPending || grants.isError) return null;

  return (
    <section aria-label="Cloudflare access" className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
      <p className="text-base font-semibold">Cloudflare access</p>
      <p className="text-muted-foreground">
        Agents ask for access in a chat, and you approve it there. Deploys and agents use only what is listed
        here.
      </p>
      <ul className="flex flex-col gap-1">
        {grants.data.map((g) => (
          <li key={g.permission} className="flex items-center justify-between gap-2">
            <span>
              <span className="font-medium">{permissionText(g.permission)}</span>
              <span className="text-muted-foreground">
                {" "}
                · {PERMISSION_GROUPS[g.permission].groups.join(", ")}
              </span>
            </span>
            {g.permission !== "workers" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ projectId, permission: g.permission })}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
