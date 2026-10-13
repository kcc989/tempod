import { ERROR_MESSAGES } from "@tempo/protocol";
import { keepPreviousData } from "@tanstack/react-query";
import { FileIcon, RegexIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/ui/components/ui/command";
import { LoadingText } from "~/ui/components/ui/spinner";
import { Button } from "~/ui/components/ui/button";
import { PhoneUnavailable } from "~/ui/components/shell/States";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { Toggle } from "~/ui/components/ui/toggle";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useCallQuery } from "~/ui/hooks/useCall";
import { useDebounced } from "~/ui/hooks/useDebounced";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { fuzzyFilter } from "~/ui/lib/fuzzy";
import { Store } from "~/ui/lib/store";
import { errorCode, errorText } from "~/ui/lib/toast";
import { closeDialog, openFile } from "~/ui/state/workspace-ui";
import { splitPath } from "./changes-model";
import { WakeButton } from "./parts";
import { groupMatches, SEARCH_DEBOUNCE_MS, SEARCH_LIMIT } from "./search-model";
import { useFileList, useLive } from "./use-review";

/** Mounted hosts per workspace; only the first one renders, so a second mount is harmless. */
const hosts = new Store<ReadonlyArray<string>>([]);

function useIsFirstHost(workspaceId: string): boolean {
  const id = useId();
  const token = `${workspaceId}\u0000${id}`;
  useEffect(() => {
    hosts.set((cur) => [...cur, token]);

    return () => hosts.set((cur) => cur.filter((t) => t !== token));
  }, [token]);

  const first = useSyncExternalStore(
    hosts.subscribe,
    () => hosts.getSnapshot().find((t) => t.startsWith(`${workspaceId}\u0000`)) ?? null,
    () => null,
  );

  return first === token;
}

/**
 * The ⌘P file picker and the ⌘⇧F search (dialog kinds `openFile` and `searchFiles`). Mount it
 * wherever the workspace shows; extra mounts render nothing.
 */
export function ReviewDialogs({ workspaceId }: { workspaceId: string }) {
  const first = useIsFirstHost(workspaceId);

  if (!first) return null;

  return (
    <>
      <OpenFileDialog workspaceId={workspaceId} />
      <SearchFilesDialog workspaceId={workspaceId} />
    </>
  );
}

function OpenFileDialog({ workspaceId }: { workspaceId: string }) {
  const { open, args, onOpenChange } = useDialog("openFile");
  const mine = open && args?.workspaceId === workspaceId;

  return (
    <CommandDialog
      open={mine}
      onOpenChange={onOpenChange}
      title="Open file"
      description="Type part of a file name."
      commandProps={{ shouldFilter: false, loop: true }}
    >
      {mine && <OpenFileBody workspaceId={workspaceId} />}
    </CommandDialog>
  );
}

function OpenFileBody({ workspaceId }: { workspaceId: string }) {
  const phone = useIsPhone();
  const [query, setQuery] = useState("");
  const { query: files, available } = useFileList(workspaceId);
  const paths = files.data?.paths;
  const results = useMemo(() => fuzzyFilter(query, paths ?? [], (p) => p, 50), [query, paths]);

  const pick = (path: string) => {
    closeDialog("openFile");
    openFile(workspaceId, path);
  };

  return (
    <>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Open file" aria-label="File name" />
      <CommandList>
        {phone ? (
          <PhoneUnavailable />
        ) : !available || (files.isError && !paths && errorCode(files.error) === "CONTAINER_NOT_READY") ? (
          <div className="flex justify-center p-4">
            <WakeButton workspaceId={workspaceId} label="Wake to browse files" />
          </div>
        ) : files.isPending ? (
          <div className="flex justify-center p-4">
            <LoadingText label="Loading files" />
          </div>
        ) : files.isError && !paths ? (
          <div className="flex flex-col items-center gap-2 p-4 text-sm text-muted-foreground">
            <p>{errorText(files.error)}</p>
            <Button size="sm" variant="outline" onClick={() => void files.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <CommandEmpty>No matching files.</CommandEmpty>
            {results.map((path) => {
              const { dir, name } = splitPath(path);

              return (
                <CommandItem key={path} value={path} onSelect={() => pick(path)}>
                  <FileIcon />
                  <span className="shrink-0">{name}</span>
                  {dir && <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span>}
                </CommandItem>
              );
            })}
          </>
        )}
      </CommandList>
    </>
  );
}

function SearchFilesDialog({ workspaceId }: { workspaceId: string }) {
  const { open, args, onOpenChange } = useDialog("searchFiles");
  const mine = open && args?.workspaceId === workspaceId;

  return (
    <CommandDialog
      open={mine}
      onOpenChange={onOpenChange}
      title="Search files"
      description="Search the text of every file in the workspace."
      className="sm:max-w-2xl"
      commandProps={{ shouldFilter: false, loop: true }}
    >
      {mine && <SearchBody workspaceId={workspaceId} />}
    </CommandDialog>
  );
}

function SearchBody({ workspaceId }: { workspaceId: string }) {
  const phone = useIsPhone();
  const [text, setText] = useState("");
  const [regex, setRegex] = useState(false);
  const live = useLive(workspaceId);
  const query = useDebounced(text.trim(), SEARCH_DEBOUNCE_MS);

  const search = useCallQuery("searchFiles", regex ? { workspaceId, query, regex } : { workspaceId, query }, {
    enabled: !phone && live && query !== "",
    retry: false,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  const groups = useMemo(() => groupMatches(search.data ?? []), [search.data]);

  const pick = (path: string, line: number) => {
    closeDialog("searchFiles");
    openFile(workspaceId, path, line);
  };

  const count = search.data?.length ?? 0;

  return (
    <>
      <div className="flex items-center gap-1 border-b pr-2 [&_[data-slot=command-input-wrapper]]:flex-1 [&_[data-slot=command-input-wrapper]]:border-b-0">
        <CommandInput
          value={text}
          onValueChange={setText}
          placeholder="Search files"
          aria-label="Search text"
        />
        <SimpleTooltip label="Regular expression">
          <Toggle size="sm" aria-label="Regular expression" pressed={regex} onPressedChange={setRegex}>
            <RegexIcon />
          </Toggle>
        </SimpleTooltip>
      </div>
      <CommandList className="max-h-[420px]">
        {phone ? (
          <PhoneUnavailable />
        ) : !live ? (
          <div className="flex justify-center p-4">
            <WakeButton workspaceId={workspaceId} label="Wake to search files" />
          </div>
        ) : query === "" ? null : search.isPending ? (
          <div className="flex justify-center p-4">
            <LoadingText label="Searching" />
          </div>
        ) : search.isError ? (
          <p className="p-4 text-center text-sm text-muted-foreground">
            {errorCode(search.error) === "CONTAINER_NOT_READY"
              ? ERROR_MESSAGES.CONTAINER_NOT_READY
              : errorText(search.error)}
          </p>
        ) : (
          <>
            <CommandEmpty>No matches.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.path} heading={g.path}>
                {g.matches.map((m) => (
                  <CommandItem
                    key={`${g.path}:${m.line}`}
                    value={`${g.path}:${m.line}`}
                    onSelect={() => pick(g.path, m.line)}
                  >
                    <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
                      {m.line}
                    </span>
                    <span className="min-w-0 truncate font-mono text-xs">{m.text}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {count >= SEARCH_LIMIT && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                Showing the first {SEARCH_LIMIT} matches.
              </p>
            )}
          </>
        )}
      </CommandList>
    </>
  );
}
