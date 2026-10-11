import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  ScriptOnce,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppProviders } from "~/ui/components/shell/AppProviders";
import { ErrorState, NotFoundState } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { THEME_BOOT_SCRIPT } from "~/ui/lib/theme";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "color-scheme", content: "light dark" },
      { title: "Tempo" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: RootNotFound,
  errorComponent: RootError,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ScriptOnce>{THEME_BOOT_SCRIPT}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <AppProviders>
      <Outlet />
    </AppProviders>
  );
}

function RootNotFound() {
  return (
    <NotFoundState
      className="h-dvh"
      action={
        <Button asChild size="sm" variant="outline">
          <Link to="/">Go to workspaces</Link>
        </Button>
      }
    />
  );
}

function RootError({ error, reset }: ErrorComponentProps) {
  return <ErrorState className="h-dvh" error={error} onRetry={reset} />;
}
