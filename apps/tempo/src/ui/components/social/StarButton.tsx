import type { StarState } from "@tempo/protocol";
import { useNavigate } from "@tanstack/react-router";
import { StarIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/ui/components/ui/button";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useCallMutation } from "~/ui/hooks/useCall";

/** 04, Star button: shows the count the server returns; anonymous viewers go to sign-in. */
export function StarButton({
  projectId,
  initial,
  signedIn,
}: {
  projectId: string;
  initial: StarState;
  signedIn: boolean;
}) {
  const navigate = useNavigate();
  const [state, setState] = useState(initial);
  const options = { invalidates: ["listStarredProjects", "exploreProjects"] as const, onSuccess: setState };
  const star = useCallMutation("starProject", options);
  const unstar = useCallMutation("unstarProject", options);
  const pending = star.isPending || unstar.isPending;

  if (!signedIn)
    return (
      <SimpleTooltip label="Sign in to star">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/login",
              search: { redirect: `${window.location.pathname}${window.location.search}` },
            })
          }
        >
          <StarIcon />
          Star
          <span className="text-muted-foreground">{state.stars}</span>
        </Button>
      </SimpleTooltip>
    );

  return (
    <Button
      size="sm"
      variant="outline"
      aria-pressed={state.starred}
      disabled={pending}
      onClick={() => (state.starred ? unstar : star).mutate({ projectId })}
    >
      <StarIcon className={state.starred ? "fill-current" : undefined} />
      {state.starred ? "Starred" : "Star"}
      <span className="text-muted-foreground">{state.stars}</span>
    </Button>
  );
}
