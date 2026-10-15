import type { CloudflareHoldContent } from "@tempo/protocol";
import { Button } from "~/ui/components/ui/button";
import { useCallMutation } from "~/ui/hooks/useCall";
import { holdReasonText, holdStatusText } from "./transcript-model";

/** 13, L-ADR-8: a Cloudflare API request that waits for the owner. */
export function CloudflareHoldCard({
  workspaceId,
  hold,
  writable,
}: {
  workspaceId: string;
  hold: CloudflareHoldContent;
  writable: boolean;
}) {
  const decide = useCallMutation("decideCloudflareHold");
  const answer = (allow: boolean) => decide.mutate({ workspaceId, holdId: hold.holdId, allow });

  return (
    <section
      aria-label="Cloudflare request"
      className="mx-4 flex flex-col gap-2 rounded-lg border p-3 text-sm"
    >
      <p className="text-xs font-medium text-muted-foreground">{holdStatusText(hold.status)}</p>
      <p className="font-mono text-xs break-all">
        {hold.method} {hold.path}
      </p>
      {hold.reasons.length > 0 && (
        <p className="text-xs text-muted-foreground">Held because: {holdReasonText(hold.reasons)}</p>
      )}
      {writable && hold.status === "pending" && (
        <div className="flex gap-2">
          <Button size="sm" disabled={decide.isPending} onClick={() => answer(true)}>
            Allow once
          </Button>
          <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => answer(false)}>
            Refuse
          </Button>
        </div>
      )}
    </section>
  );
}
