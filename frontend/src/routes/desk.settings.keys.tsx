import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysSettingsPage } from "@/features/settings/api-keys-page";

export const Route = createFileRoute("/desk/settings/keys")({ component: ApiKeysSettingsPage });
