import { Schema } from "effect";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  approveDevice,
  claimDeviceCode,
  denyDevice,
  deviceOutcomeText,
  formatUserCode,
  normalizeUserCode,
  sessionQueryOptions,
  type DeviceLookup,
} from "~/ui/auth";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Label } from "~/ui/components/ui/label";
import { LoadingText } from "~/ui/components/ui/spinner";

interface DeviceSearch {
  readonly user_code?: string;
}

/** 07: where the owner approves a Tempo for Mac sign-in. */
export const Route = createFileRoute("/device")({
  validateSearch: (search: Schema.JsonObject): DeviceSearch =>
    Schema.is(Schema.String)(search["user_code"]) ? { user_code: search["user_code"] } : {},
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);

    if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: DevicePage,
});

function DevicePage() {
  const { user_code } = Route.useSearch();

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border p-6">
        <h1 className="text-lg font-semibold">Sign in Tempo for Mac</h1>
        {user_code ? <Approve userCode={user_code} /> : <EnterCode />}
      </div>
    </main>
  );
}

function EnterCode() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();

        if (normalizeUserCode(code))
          void navigate({ to: "/device", search: { user_code: normalizeUserCode(code) } });
      }}
    >
      <Label htmlFor="user-code">Enter the code shown in Tempo for Mac.</Label>
      <Input
        id="user-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        className="font-mono uppercase"
      />
      <Button type="submit" disabled={!normalizeUserCode(code)}>
        Continue
      </Button>
    </form>
  );
}

function Approve({ userCode }: { userCode: string }) {
  const claim = useQuery({
    queryKey: ["device", "claim", userCode],
    queryFn: () => claimDeviceCode(userCode),
    staleTime: Infinity,
    retry: false,
  });

  const [decided, setDecided] = useState<DeviceLookup | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setDecided(await (approve ? approveDevice(userCode) : denyDevice(userCode)));
    setBusy(false);
  };

  if (claim.isPending) return <LoadingText label="Checking the code" />;
  const result = decided ?? claim.data ?? { ok: false as const, reason: "error" as const };
  const done = !result.ok || result.status !== "pending";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-center font-mono text-2xl tracking-widest" aria-label="Code">
        {formatUserCode(userCode)}
      </p>
      {done ? (
        <p role="status" className={result.ok ? "text-sm" : "text-sm text-destructive"}>
          {deviceOutcomeText(result)}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Check that this code matches the one in Tempo for Mac.
          </p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => void decide(true)} disabled={busy}>
              Approve
            </Button>
            <Button className="flex-1" variant="outline" onClick={() => void decide(false)} disabled={busy}>
              Deny
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
