import { createFileRoute } from "@tanstack/react-router";
import { ViewRoute } from "@/features/grant-view/view-route";

export const Route = createFileRoute("/view")({ component: ViewRoute });
