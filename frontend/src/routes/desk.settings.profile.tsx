import { createFileRoute } from "@tanstack/react-router";
import { ProfileSettingsPage } from "@/features/settings/profile-page";

export const Route = createFileRoute("/desk/settings/profile")({ component: ProfileSettingsPage });
