import { createFileRoute } from "@tanstack/react-router";
import { WebhooksPage } from "@/features/webhooks/webhooks-page";

export const Route = createFileRoute("/desk/webhooks")({ component: WebhooksPage });
