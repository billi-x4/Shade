import { createFileRoute } from "@tanstack/react-router";
import { GrantsPage } from "@/features/grants/grants-page";

export const Route = createFileRoute("/desk/grants")({ component: GrantsPage });
