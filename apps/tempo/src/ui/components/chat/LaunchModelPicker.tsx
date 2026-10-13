import type { Project } from "@tempo/protocol";
import { useState } from "react";
import { Button } from "~/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/ui/components/ui/select";
import { useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { useCustomAgents } from "~/ui/hooks/useCustomAgents";
import { agentLabel } from "~/ui/lib/agents";
import { openDialog } from "~/ui/state/workspace-ui";
import {
  agentsWithLogin,
  customAgentOf,
  customAgentValue,
  customAgentsWithLogin,
  initialAgent,
  initialModel,
  modelChoices,
} from "~/ui/components/dialogs/new-workspace-model";

export function useLaunchModels(settings: Project["settings"]) {
  const credentials = useCredentialStatus();
  const models = useCallQuery("listModels", {}, { staleTime: 30_000, enabled: credentials.isSuccess });
  const available = agentsWithLogin(credentials.data);
  const choices = modelChoices(available, models.data ?? []);
  const custom = customAgentsWithLogin(useCustomAgents().data, available);
  const [picked, setPicked] = useState<string | null>(null);
  const selected =
    choices.find((choice) => choice.key === picked) ?? initialModel(choices, models.data ?? [], { settings });
  const pickedCustom = customAgentOf(picked, custom);
  return {
    credentials,
    models,
    available,
    choices,
    custom,
    selected,
    pickedCustom,
    setPicked,
    fallbackAgent: initialAgent(available, { settings }),
  };
}

export function LaunchModelPicker({
  selection,
  disabled,
  onClosed,
}: {
  selection: ReturnType<typeof useLaunchModels>;
  disabled: boolean;
  onClosed: () => void;
}) {
  const { credentials, models, choices, custom, selected, pickedCustom, setPicked } = selection;
  return (
    <div className="min-w-0">
      <Select
        value={pickedCustom ? customAgentValue(pickedCustom.id) : (selected?.key ?? "")}
        onValueChange={(value) => {
          if (value === "manage-agents") openDialog({ kind: "settings", tab: "agents" });
          else setPicked(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-label="Model" className="w-auto max-w-full border-0 bg-transparent shadow-none">
          <SelectValue
            placeholder={credentials.isPending || models.isPending ? "Loading models…" : "Choose a model"}
          />
        </SelectTrigger>
        <SelectContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          {choices.map((choice) => (
            <SelectItem key={choice.key} value={choice.key}>
              {choice.name} <span className="text-muted-foreground">· {agentLabel(choice.agent)}</span>
            </SelectItem>
          ))}
          {custom.length > 0 && choices.length > 0 && <SelectSeparator />}
          {custom.map((agent) => (
            <SelectItem key={agent.id} value={customAgentValue(agent.id)}>
              {agent.name} <span className="text-muted-foreground">· {agentLabel(agent.baseAgent)}</span>
            </SelectItem>
          ))}
          {(custom.length > 0 || choices.length > 0) && <SelectSeparator />}
          <SelectItem value="manage-agents">Manage agents…</SelectItem>
        </SelectContent>
      </Select>
      {models.isError && (
        <Button variant="link" size="sm" onClick={() => void models.refetch()}>
          Retry loading models
        </Button>
      )}
    </div>
  );
}
