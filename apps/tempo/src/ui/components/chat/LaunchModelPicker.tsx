import { AGENT_IDS, type AgentId } from "@tempo/protocol";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/ui/components/ui/command";
import { Input } from "~/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/components/ui/popover";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { agentLabel, hasLogin } from "~/ui/lib/agents";
import { knownModels } from "~/ui/stores/workspace-store";

export function LaunchModelPicker({
  agent,
  model,
  defaultModel,
  disabled = false,
  onPick,
  onClosed,
}: {
  agent: AgentId | null;
  model: string;
  defaultModel?: string;
  disabled?: boolean;
  onPick: (agent: AgentId, model: string) => void;
  onClosed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const credentials = useCredentialStatus();
  const models = knownModels();
  const selected = models.find((m) => m.agent === agent && m.value === (model || defaultModel));
  const pick = (a: AgentId, value: string) => {
    onPick(a, value);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Select model"
          disabled={disabled}
          className="text-muted-foreground"
        >
          {selected?.name ||
            model ||
            defaultModel ||
            (agent ? `${agentLabel(agent)} · Default` : "Select model")}
          <ChevronDownIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 p-0"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
      >
        <Command>
          <CommandInput placeholder="Search models" />
          <CommandList>
            <CommandEmpty>No matching models.</CommandEmpty>
            {AGENT_IDS.map((a) => (
              <CommandGroup key={a} heading={agentLabel(a)}>
                <CommandItem
                  value={`${a} default`}
                  disabled={!hasLogin(a, credentials.data)}
                  onSelect={() => pick(a, "")}
                >
                  Default
                  {!hasLogin(a, credentials.data) && (
                    <span className="ml-auto text-xs text-muted-foreground">Add login in Settings</span>
                  )}
                </CommandItem>
                {models
                  .filter((m) => m.agent === a)
                  .map((m) => (
                    <CommandItem
                      key={m.value}
                      value={`${a} ${m.name} ${m.value}`}
                      disabled={!hasLogin(a, credentials.data)}
                      onSelect={() => pick(a, m.value)}
                    >
                      {m.name}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        {agent && (
          <div className="flex gap-2 border-t p-2">
            <Input
              aria-label="Custom model ID"
              placeholder="Custom model ID"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (custom.trim()) pick(agent, custom.trim());
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!custom.trim()}
              onClick={() => pick(agent, custom.trim())}
            >
              Use
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
