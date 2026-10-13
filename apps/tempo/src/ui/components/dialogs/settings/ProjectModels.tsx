import { AGENT_IDS, DEFAULT_SETTINGS, type AgentId } from "@tempo/protocol";
import { useState } from "react";
import { Button } from "~/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { agentLabel, hasLogin } from "~/ui/lib/agents";
import { errorText } from "~/ui/lib/toast";
import { openDialog } from "~/ui/state/workspace-ui";
import { modelChoices } from "../new-workspace-model";
import {
  effectiveLeaf,
  fieldDef,
  sourceLabel,
  type EffectiveContext,
  type FieldPath,
  type FieldState,
  type SettingsForm,
} from "../settings-model";

const modelPath = (agent: AgentId): FieldPath => `agent.models.${agent}`;
const inherited = "agent-default";
const text = (state: FieldState): string => (state.value.kind === "text" ? state.value.text : "");
const override = (value: string): FieldState => ({ set: true, value: { kind: "text", text: value } });

export function ProjectModels({
  form,
  initial,
  ctx,
  onChange,
  disabled,
}: {
  form: SettingsForm;
  initial: SettingsForm;
  ctx: EffectiveContext;
  onChange: (changes: Partial<SettingsForm>) => void;
  disabled: boolean;
}) {
  const credentials = useCredentialStatus();
  const available = AGENT_IDS.filter((agent) => hasLogin(agent, credentials.data));
  const models = useCallQuery(
    "listModels",
    {},
    { staleTime: 30_000, enabled: credentials.isSuccess && available.length > 0 },
  );
  const choices = modelChoices(available, models.data ?? []);
  const agent = AGENT_IDS.find((a) => a === text(form["agent.default"])) ?? DEFAULT_SETTINGS.agent.default;
  const path = modelPath(agent);
  const configured = text(form[path]);
  const current = models.data?.find((entry) => entry.agent === agent)?.currentValue;
  const selected = choices.find((c) => c.agent === agent && c.model === (configured || current));
  const loading = credentials.isPending || (available.length > 0 && models.isPending);
  const failure = credentials.isError ? credentials.error : models.isError ? models.error : null;
  const [reset, setReset] = useState<Partial<SettingsForm> | null>(null);
  const own = form["agent.default"].set || form[path].set;
  const source = own ? "tempo" : effectiveLeaf(fieldDef(path), ctx).source;
  const restore = (key: FieldPath): FieldState => ({ ...initial[key], set: false });

  return (
    <div className="grid gap-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="project-default-model" className="text-sm font-medium">
          Default model
        </label>
        {!reset && <span className="text-xs text-muted-foreground">{sourceLabel(source)}</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Used for new workspaces and chats. Choosing a model also selects its agent.
      </p>
      {reset ? (
        <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          Save to restore the repository or default value.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(reset);
              setReset(null);
            }}
          >
            Undo reset
          </Button>
        </div>
      ) : (
        <Select
          value={form["agent.default"].set && form[path].set ? (selected?.key ?? "") : ""}
          disabled={disabled || loading || failure !== null || choices.length === 0}
          onValueChange={(key) => {
            const choice = choices.find((c) => c.key === key);
            if (!choice) return;
            onChange({
              "agent.default": override(choice.agent),
              [modelPath(choice.agent)]: override(choice.model),
            });
          }}
        >
          <SelectTrigger id="project-default-model" aria-label="Default model" className="w-full max-w-md">
            <SelectValue
              placeholder={
                loading
                  ? "Loading models…"
                  : selected
                    ? `${selected.name} · ${agentLabel(selected.agent)}`
                    : "Choose a model"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {choices.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.name} · {agentLabel(c.agent)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {!reset && !loading && !failure && !selected && (
        <p role="status" className="text-xs text-muted-foreground">
          {available.length === 0
            ? "Connect an agent to choose a model."
            : `Configured default: ${agentLabel(agent)}${configured ? ` · ${configured}` : " · agent default"}. It is not in the available model list. Your saved default is unchanged.`}
        </p>
      )}
      {failure !== null && (
        <div role="alert" className="flex items-center gap-2 text-xs">
          {errorText(failure)}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void (credentials.isError ? credentials.refetch() : models.refetch())}
          >
            Retry loading models
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => openDialog({ kind: "settings", tab: "logins" })}
        >
          Connect another agent
        </Button>
        {own && !reset && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              if (initial["agent.default"].set || initial[path].set)
                setReset({ "agent.default": form["agent.default"], [path]: form[path] });
              onChange({ "agent.default": restore("agent.default"), [path]: restore(path) });
            }}
          >
            Reset default model to inherited
          </Button>
        )}
      </div>
      {available.some((a) => a !== agent) && (
        <details className="border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <p className="mt-2 text-xs text-muted-foreground">
            Defaults for other connected agents. These do not change the project's Default model.
          </p>
          {available
            .filter((a) => a !== agent)
            .map((a) => {
              const key = modelPath(a);
              const value = text(form[key]);
              const options = choices.filter((c) => c.agent === a);
              const savedOverride = initial[key].set && !form[key].set;
              const known = options.some((c) => c.model === value);
              return (
                <div key={a} className="mt-4 grid gap-2">
                  <label htmlFor={`project-model-${a}`} className="text-sm">
                    {agentLabel(a)} default model
                  </label>
                  {savedOverride ? (
                    <div role="status" className="text-xs text-muted-foreground">
                      Save to restore the repository or default value.
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onChange({ [key]: { ...form[key], set: true } })}
                      >
                        Undo reset
                      </Button>
                    </div>
                  ) : (
                    <Select
                      value={
                        form[key].set
                          ? value === "" && (a === "claude" || a === "codex")
                            ? inherited
                            : known
                              ? (options.find((c) => c.model === value)?.key ?? "")
                              : ""
                          : ""
                      }
                      disabled={disabled || loading || failure !== null}
                      onValueChange={(v) =>
                        onChange({
                          [key]: override(
                            v === inherited ? "" : (options.find((c) => c.key === v)?.model ?? value),
                          ),
                        })
                      }
                    >
                      <SelectTrigger
                        id={`project-model-${a}`}
                        aria-label={`${agentLabel(a)} default model`}
                        className="w-full max-w-md"
                      >
                        <SelectValue
                          placeholder={
                            value === ""
                              ? a === "claude" || a === "codex"
                                ? "Use agent default"
                                : "Choose a model"
                              : (options.find((c) => c.model === value)?.name ??
                                "Configured model is unavailable")
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {(a === "claude" || a === "codex") && (
                          <SelectItem value={inherited}>Use agent default</SelectItem>
                        )}
                        {options.map((c) => (
                          <SelectItem key={c.key} value={c.key}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {value !== "" && !known && (
                    <p className="text-xs text-muted-foreground">
                      Configured model: {value}. Saved value is unchanged.
                    </p>
                  )}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {!savedOverride &&
                      sourceLabel(form[key].set ? "tempo" : effectiveLeaf(fieldDef(key), ctx).source)}
                    {form[key].set && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        onClick={() =>
                          onChange({
                            [key]: {
                              set: false,
                              value: initial[key].set ? form[key].value : initial[key].value,
                            },
                          })
                        }
                      >
                        Reset to inherited
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
        </details>
      )}
    </div>
  );
}
