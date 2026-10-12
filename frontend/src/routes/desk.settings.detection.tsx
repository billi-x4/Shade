import { createFileRoute } from "@tanstack/react-router";
import { DetectionSettingsPage } from "@/features/settings/detection-page";

export const Route = createFileRoute("/desk/settings/detection")({
  component: DetectionSettingsPage,
});
