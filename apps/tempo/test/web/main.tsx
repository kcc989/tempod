import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AppProviders } from "~/ui/components/shell/AppProviders";
import { AppShell } from "~/ui/components/shell/AppShell";
import { WorkspaceLayout } from "~/ui/components/shell/WorkspaceLayout";
import { Route as HomeRoute } from "~/routes/_app/index";
import { Route as HistoryRoute } from "~/routes/_app/history";
import "~/styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <AppProviders>
        <AppShell>
          <Outlet />
        </AppShell>
      </AppProviders>
    </QueryClientProvider>
  ),
});
const home = createRoute({ getParentRoute: () => root, path: "/", component: HomeRoute.options.component });
const history = createRoute({
  getParentRoute: () => root,
  path: "/history",
  component: HistoryRoute.options.component,
});
const workspace = createRoute({
  getParentRoute: () => root,
  path: "/w/$workspaceId",
  component: () => {
    const { workspaceId } = workspace.useParams();
    return <WorkspaceLayout workspaceId={workspaceId} key={workspaceId} />;
  },
});
const router = createRouter({ routeTree: root.addChildren([home, history, workspace]) });
await router.load();
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
