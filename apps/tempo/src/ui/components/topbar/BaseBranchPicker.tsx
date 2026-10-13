import { ChevronDownIcon, CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorState } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/components/ui/popover";
import { Skeleton } from "~/ui/components/ui/skeleton";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { baseBranchOptions } from "./topbar-logic";

const DEBOUNCE_MS = 200;

/**
 * `→ <base branch>`. Until a PR exists it opens a searchable branch list (listBranches) and calls
 * setBaseBranch (04, Top bar).
 */
export function BaseBranchPicker({
  workspaceId,
  projectId,
  branch,
  baseBranch,
  locked,
}: {
  workspaceId: string;
  projectId: string;
  branch: string;
  baseBranch: string;
  /** A PR exists (or the workspace is archived): the base is shown, not picked. */
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);

  const label = (
    <>
      <span className="text-muted-foreground">Base:</span>
      <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{baseBranch}</span>
    </>
  );

  if (locked) {
    return (
      <span
        aria-label={`Base branch ${baseBranch}`}
        className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground"
      >
        {label}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Base branch ${baseBranch}. Change base branch`}
          className="h-6 min-w-0 gap-1 px-1 font-mono text-xs font-normal text-muted-foreground"
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        {open && (
          <BranchList
            workspaceId={workspaceId}
            projectId={projectId}
            branch={branch}
            baseBranch={baseBranch}
            onDone={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function BranchList({
  workspaceId,
  projectId,
  branch,
  baseBranch,
  onDone,
}: {
  workspaceId: string;
  projectId: string;
  branch: string;
  baseBranch: string;
  onDone: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), DEBOUNCE_MS);

    return () => clearTimeout(t);
  }, [search]);

  const branches = useCallQuery("listBranches", query ? { projectId, query } : { projectId }, {
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const setBase = useCallMutation("setBaseBranch");
  const options = baseBranchOptions(branches.data ?? [], branch);

  return (
    <Command shouldFilter={false} label="Base branch">
      <CommandInput value={search} onValueChange={setSearch} placeholder="Search branches" />
      <CommandList>
        {branches.isPending ? (
          <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-1.5 p-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : branches.isError ? (
          <ErrorState error={branches.error} onRetry={() => void branches.refetch()} className="p-3" />
        ) : (
          <>
            <CommandEmpty>No branches.</CommandEmpty>
            <CommandGroup>
              {options.map((name) => (
                <CommandItem
                  key={name}
                  value={name}
                  onSelect={() => {
                    if (name !== baseBranch) setBase.mutate({ workspaceId, baseBranch: name });
                    onDone();
                  }}
                  className="justify-start text-left font-mono text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {name === baseBranch && <CheckIcon className="ml-auto" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
