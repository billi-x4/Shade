import { createFileRoute } from "@tanstack/react-router";
import { PayRoute } from "@/features/pay/pay-route";

export const Route = createFileRoute("/pay/$id")({ component: PayRoute });
