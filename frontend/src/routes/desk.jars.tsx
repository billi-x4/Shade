import { createFileRoute } from "@tanstack/react-router";
import { JarsPage } from "@/features/jars/jars-page";

export const Route = createFileRoute("/desk/jars")({ component: JarsPage });
