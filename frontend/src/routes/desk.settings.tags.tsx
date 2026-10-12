import { createFileRoute } from "@tanstack/react-router";
import { TagsSettingsPage } from "@/features/settings/tags-page";

export const Route = createFileRoute("/desk/settings/tags")({ component: TagsSettingsPage });
