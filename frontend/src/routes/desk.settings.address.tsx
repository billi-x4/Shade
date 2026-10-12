import { createFileRoute } from "@tanstack/react-router";
import { AddressSettingsPage } from "@/features/settings/address-page";

export const Route = createFileRoute("/desk/settings/address")({ component: AddressSettingsPage });
