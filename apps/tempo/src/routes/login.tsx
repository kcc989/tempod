import { Schema } from "effect";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ERROR_MESSAGES } from "@tempo/protocol";
import { LogInIcon } from "lucide-react";
import { useState } from "react";
import {
  loginErrorText,
  safeRedirect,
  sessionQueryOptions,
  setupStatusQueryOptions,
  signInWithGithub,
} from "~/ui/auth";
import { Button } from "~/ui/components/ui/button";
import { LoadingText } from "~/ui/components/ui/spinner";

interface LoginSearch {
  readonly redirect?: string;
  readonly error?: string;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Schema.JsonObject): LoginSearch => {
    let result: LoginSearch = {};

    if (Schema.is(Schema.String)(search["redirect"])) result = { ...result, redirect: search["redirect"] };

    if (Schema.is(Schema.String)(search["error"])) result = { ...result, error: search["error"] };

    return result;
  },
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions).catch(() => null);

    if (session) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginPage,
});

function LoginPage() {
  const { redirect: next, error } = Route.useSearch();
  const setup = useQuery(setupStatusQueryOptions);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const message = failed ? ERROR_MESSAGES.INTERNAL : loginErrorText(error);

  const signIn = async () => {
    setBusy(true);
    setFailed(false);

    try {
      await signInWithGithub(next);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Tempo</h1>
          <p className="text-sm text-muted-foreground">{ERROR_MESSAGES.UNAUTHENTICATED}</p>
        </div>
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
        {setup.isPending ? (
          <LoadingText label="Checking setup" />
        ) : setup.data && !setup.data.configured ? (
          <p className="text-sm">Tempo is not set up yet. Open your private setup link.</p>
        ) : (
          <Button size="lg" onClick={() => void signIn()} disabled={busy}>
            <LogInIcon />
            Sign in with GitHub
          </Button>
        )}
      </div>
    </main>
  );
}
