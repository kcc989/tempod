import { createFileRoute } from "@tanstack/react-router";
import { ProfilePage } from "~/ui/components/profile/ProfilePage";
import { PublicFrame } from "~/ui/components/profile/PublicFrame";

/** 04, `/:username`: works without a session (11). */
export const Route = createFileRoute("/$username/")({
  component: ProfileRoute,
});

function ProfileRoute() {
  const { username } = Route.useParams();

  return (
    <PublicFrame username={username}>
      <ProfilePage key={username} username={username} />
    </PublicFrame>
  );
}
