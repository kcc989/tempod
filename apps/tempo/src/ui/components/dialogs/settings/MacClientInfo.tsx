import { useQuery } from "@tanstack/react-query";
import { ApiMeta, TempoError } from "@tempo/protocol";
import * as Schema from "effect/Schema";
import { DownloadIcon, LaptopIcon } from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";

export function MacClientInfo() {
  const meta = useQuery({
    queryKey: ["mac", "meta"],
    queryFn: async () => {
      const response = await fetch("/api/v1/meta", { credentials: "same-origin" });

      if (!response.ok) throw new TempoError("INTERNAL");

      return Schema.decodeUnknownSync(ApiMeta)(await response.json());
    },
    staleTime: 60_000,
    retry: false,
  });

  const version = meta.data?.latestMacClient;

  return (
    <section aria-labelledby="mac-client-title" className="grid gap-2 rounded-lg border p-3">
      <h3 id="mac-client-title" className="flex items-center gap-2 text-sm font-semibold">
        <LaptopIcon className="size-4 text-muted-foreground" />
        Tempo for Mac
      </h3>
      {meta.isPending ? (
        <SkeletonRows rows={2} />
      ) : meta.isError ? (
        <ErrorState error={meta.error} onRetry={() => void meta.refetch()} />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Server {meta.data.serverVersion} · Requires Tempo for Mac {meta.data.minMacClient} or later.
          </p>
          {version && /^\d+\.\d+\.\d+$/.test(version) ? (
            <Button asChild size="sm" variant="outline" className="w-fit">
              <a href={`/downloads/mac/${encodeURIComponent(version)}`}>
                <DownloadIcon /> Download Tempo for Mac {version}
              </a>
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">No Mac download has been published yet.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Connect the Mac app to {globalThis.location?.origin}. Use Open in Tempo for Mac from a workspace's
            menu.
          </p>
        </>
      )}
    </section>
  );
}
