import { PERMISSION_GROUPS, type CloudflareAccessContent } from "@tempo/protocol";
import { Button } from "~/ui/components/ui/button";
import { useCallMutation } from "~/ui/hooks/useCall";
import { accessStatusText, permissionText } from "./transcript-model";

/** 12, Access requests and grants: an agent asks for Cloudflare permissions; the owner decides. */
export function CloudflareAccessCard({
  workspaceId,
  access,
  writable,
}: {
  workspaceId: string;
  access: CloudflareAccessContent;
  writable: boolean;
}) {
  const decide = useCallMutation("decideCloudflareAccess", { invalidates: ["listCloudflareGrants"] });
  const answer = (approve: boolean) => decide.mutate({ workspaceId, requestId: access.requestId, approve });

  return (
    <section
      aria-label="Cloudflare access request"
      className="mx-4 flex flex-col gap-2 rounded-lg border p-3 text-sm"
    >
      <p className="text-xs font-medium text-muted-foreground">{accessStatusText(access.status)}</p>
      <ul className="flex flex-col gap-1">
        {access.permissions.map((p) => (
          <li key={p}>
            <span className="font-medium">{permissionText(p)}</span>
            <span className="text-xs text-muted-foreground"> · {PERMISSION_GROUPS[p].groups.join(", ")}</span>
          </li>
        ))}
      </ul>
      <p className="whitespace-pre-wrap break-words text-muted-foreground">Reason: {access.reason}</p>
      {writable && access.status === "pending" && (
        <div className="flex gap-2">
          <Button size="sm" disabled={decide.isPending} onClick={() => answer(true)}>
            Approve
          </Button>
          <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => answer(false)}>
            Deny
          </Button>
        </div>
      )}
    </section>
  );
}
