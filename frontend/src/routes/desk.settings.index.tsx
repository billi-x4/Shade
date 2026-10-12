import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/desk/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/desk/settings/address" });
  },
});
