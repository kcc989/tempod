import type { Project } from "@tempo/protocol";
import { useState } from "react";
import { Button } from "~/ui/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "~/ui/components/ui/dropdown-menu";
import { ComposerModelMenu } from "./ComposerControls";
import { useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { useAgentChoices } from "~/ui/hooks/useAgentChoices";
import { agentLabel } from "~/ui/lib/agents";
import { openDialog } from "~/ui/state/workspace-ui";
import {
  agentsWithLogin,
  libraryAgentOf,
  libraryAgentValue,
  libraryAgentsWithLogin,
  initialAgent,
  initialModel,
  modelChoices,
} from "~/ui/components/dialogs/new-workspace-model";

export function useLaunchModels(settings: Project["settings"]) {
  const credentials = useCredentialStatus();
  const models = useCallQuery("listModels", {}, { staleTime: 30_000, enabled: credentials.isSuccess });
  const available = agentsWithLogin(credentials.data);
  const choices = modelChoices(available, models.data ?? []);
  const custom = libraryAgentsWithLogin(useAgentChoices(settings.agent?.default ?? "claude").data, available);
  const [picked, setPicked] = useState<string | null>(null);

  const selected =
    choices.find((choice) => choice.key === picked) ?? initialModel(choices, models.data ?? [], { settings });

  const pickedAgent = libraryAgentOf(picked, custom);

  return {
    credentials,
    models,
    available,
    choices,
    custom,
    selected,
    pickedAgent,
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
  const { credentials, models, choices, custom, selected, pickedAgent, setPicked } = selection;
  const [open, setOpen] = useState(false);

  const label =
    pickedAgent?.name ??
    selected?.name ??
    (credentials.isPending || models.isPending ? "Loading models…" : "Choose a model");

  return (
    <div className="min-w-0">
      <ComposerModelMenu
        label={label}
        ariaLabel="Model"
        open={open}
        onOpenChange={setOpen}
        disabled={disabled}
        onClosed={onClosed}
      >
        <DropdownMenuRadioGroup
          value={pickedAgent ? libraryAgentValue(pickedAgent.id) : (selected?.key ?? "")}
          onValueChange={setPicked}
        >
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.key} value={choice.key}>
              {choice.name} <span className="text-muted-foreground">· {agentLabel(choice.agent)}</span>
            </DropdownMenuRadioItem>
          ))}
          {custom.length > 0 && choices.length > 0 && <DropdownMenuSeparator />}
          {custom.map((agent) => (
            <DropdownMenuRadioItem key={agent.id} value={libraryAgentValue(agent.id)}>
              {agent.name} <span className="text-muted-foreground">· {agentLabel(agent.baseAgent)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {(custom.length > 0 || choices.length > 0) && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => openDialog({ kind: "settings", tab: "agents" })}>
          Manage agents…
        </DropdownMenuItem>
      </ComposerModelMenu>
      {models.isError && (
        <Button type="button" variant="link" size="sm" onClick={() => void models.refetch()}>
          Retry loading models
        </Button>
      )}
    </div>
  );
}
