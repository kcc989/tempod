import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { sessionQueryOptions } from "~/ui/auth";
import { AppShell } from "~/ui/components/shell/AppShell";
import { CenteredLoading } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";

/**
 * 04, Public profile: the owner sees the normal app frame; a visitor gets a slim top bar. A failed
 * session check counts as a visitor, since these pages need no session.
 */
export function PublicFrame({ username, children }: { username: string; children: ReactNode }) {
  const session = useQuery(sessionQueryOptions);

  if (session.isPending) return <CenteredLoading className="h-dvh" label="Loading Tempo" />;

  if (session.data) return <AppShell>{children}</AppShell>;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-10 shrink-0 items-center gap-4 border-b bg-muted px-4 text-sm">
        <Link to="/$username" params={{ username }} className="font-semibold">
          {username}
        </Link>
        <Button asChild size="sm" variant="outline" className="ml-auto">
          <Link
            to="/login"
            search={{
              redirect: `${globalThis.location?.pathname ?? "/"}${globalThis.location?.search ?? ""}`,
            }}
          >
            Sign in
          </Link>
        </Button>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
