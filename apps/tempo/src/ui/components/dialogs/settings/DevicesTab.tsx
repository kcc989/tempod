import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LaptopIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import {
  listDeviceSessions,
  revokeDeviceSession,
  sessionLabel,
  sessionQueryOptions,
  type DeviceSession,
} from "~/ui/auth";
import { formatDateTime, formatRelative } from "~/ui/lib/format";
import { toastError } from "~/ui/lib/toast";
import { MacClientInfo } from "./MacClientInfo";

const DEVICES_KEY = ["auth", "devices"] as const;

const deviceIcon = (label: string) =>
  /iOS|Android/.test(label)
    ? SmartphoneIcon
    : /Tempo for Mac|macOS|Windows|Linux/.test(label)
      ? LaptopIcon
      : MonitorIcon;

/** Settings → Devices (07): every sign-in session, including Tempo for Mac, with Revoke. */
export function DevicesTab() {
  const queryClient = useQueryClient();
  const session = useQuery(sessionQueryOptions);
  const currentId = session.data?.sessionId;
  const devices = useQuery({
    queryKey: [...DEVICES_KEY, currentId ?? null],
    queryFn: () => listDeviceSessions(currentId),
    enabled: !session.isPending,
  });
  const revoke = useMutation({
    mutationFn: (d: DeviceSession) => revokeDeviceSession(d.token),
    onSuccess: async (_, d) => {
      toast.success(`${sessionLabel(d.userAgent)} signed out`);
      await queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
    },
    onError: (e) => toastError(e),
  });

  if (session.isPending || devices.isPending) return <SkeletonRows rows={3} />;
  if (devices.isError) return <ErrorState error={devices.error} onRetry={() => void devices.refetch()} />;

  return (
    <div className="grid gap-2">
      <MacClientInfo />
      <p className="text-xs text-muted-foreground">
        Where you are signed in, including Tempo for Mac. Revoke a sign-in to sign that device out.
      </p>
      {devices.data.length === 0 && <EmptyState title="No sign-ins." />}
      <ul className="flex flex-col divide-y rounded-lg border">
        {devices.data.map((d) => {
          const label = sessionLabel(d.userAgent);
          const Icon = deviceIcon(label);
          return (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2">
              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="truncate font-medium">{label}</span>
                  {d.current && <Badge variant="muted">This browser</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  Active {formatRelative(d.updatedAt)} · signed in {formatDateTime(d.createdAt)}
                  {d.ipAddress ? ` · ${d.ipAddress}` : ""}
                </p>
              </div>
              {!d.current && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revoke.isPending}
                  aria-label={`Revoke ${label}`}
                  onClick={() => revoke.mutate(d)}
                >
                  Revoke
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
