import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
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
import { useCallQuery } from "~/ui/hooks/useCall";
import { cn } from "~/ui/lib/utils";

const DEBOUNCE_MS = 200;

/** A searchable branch list over listBranches (at most 100 per search). */
export function BranchPicker({
  id,
  projectId,
  value,
  placeholder,
  label,
  onChange,
  invalid,
  allowRef = false,
}: {
  id: string;
  projectId: string;
  value: string | null;
  placeholder: string;
  label: string;
  onChange: (branch: string) => void;
  invalid?: boolean;
  allowRef?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={value ? `${label}: ${value}` : label}
          aria-invalid={invalid || undefined}
          className="w-full justify-between font-mono text-xs font-normal"
        >
          <span className={cn("truncate", !value && "font-sans text-muted-foreground")}>
            {value ?? placeholder}
          </span>
          <ChevronsUpDownIcon aria-hidden className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        {open && (
          <BranchList
            projectId={projectId}
            value={value}
            label={label}
            allowRef={allowRef}
            onPick={(b) => {
              onChange(b);
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function BranchList({
  projectId,
  value,
  label,
  onPick,
  allowRef,
}: {
  projectId: string;
  value: string | null;
  label: string;
  onPick: (branch: string) => void;
  allowRef: boolean;
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

  return (
    <Command shouldFilter={false} label={label}>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={allowRef ? "Branch, tag or commit" : "Search branches"}
      />
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
            <CommandEmpty>No branches found.</CommandEmpty>
            <CommandGroup>
              {allowRef && query && !branches.data.some((branch) => branch.name === query) && (
                <CommandItem value={query} onSelect={() => onPick(query)}>
                  Use ref: {query}
                </CommandItem>
              )}
              {branches.data.map((b) => (
                <CommandItem
                  key={b.name}
                  value={b.name}
                  onSelect={() => onPick(b.name)}
                  className="w-full min-w-0 font-mono text-xs"
                >
                  <CheckIcon
                    aria-hidden
                    className={cn("size-3", b.name === value ? "opacity-100" : "opacity-0")}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{b.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
