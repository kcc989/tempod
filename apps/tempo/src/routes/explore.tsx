import { createFileRoute } from "@tanstack/react-router";
import { ExplorePage } from "~/ui/components/social/ExplorePage";
import { PublicFrame } from "~/ui/components/social/PublicFrame";

/** 04, `/explore`: works without a session. */
export const Route = createFileRoute("/explore")({
  component: () => (
    <PublicFrame>
      <ExplorePage />
    </PublicFrame>
  ),
});
