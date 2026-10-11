import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { sessionQueryOptions } from "~/ui/auth";
import { AppShell } from "~/ui/components/shell/AppShell";
import { CenteredLoading } from "~/ui/components/shell/States";

/** Every signed-in page. Signed out → /login, then back here. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { session };
  },
  pendingComponent: () => <CenteredLoading className="h-dvh" label="Loading Tempo" />,
  component: AppLayout,
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
