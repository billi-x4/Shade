import { createFileRoute } from "@tanstack/react-router";
import { DocsPage } from "@/features/docs/docs-page";

export const Route = createFileRoute("/docs")({ component: DocsPage });
