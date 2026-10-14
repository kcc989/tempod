import { createFileRoute } from "@tanstack/react-router";
import { NamespacePage } from "~/ui/components/social/NamespacePage";
import { PublicFrame } from "~/ui/components/social/PublicFrame";

/** 04, `/:namespace`: works without a session. */
export const Route = createFileRoute("/$namespace/")({
  component: NamespaceRoute,
});

function NamespaceRoute() {
  const { namespace } = Route.useParams();

  return (
    <PublicFrame>
      <NamespacePage key={namespace} namespace={namespace} />
    </PublicFrame>
  );
}
