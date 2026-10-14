import { createFileRoute } from "@tanstack/react-router";
import { OrganizationsPage } from "~/ui/components/social/OrganizationsPage";

export const Route = createFileRoute("/_app/organizations")({ component: OrganizationsPage });
