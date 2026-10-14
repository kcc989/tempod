import { createFileRoute } from "@tanstack/react-router";
import { StarsPage } from "~/ui/components/social/StarsPage";

export const Route = createFileRoute("/_app/stars")({ component: StarsPage });
