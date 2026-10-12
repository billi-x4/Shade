import { PublicPage } from "@/components/site-header";
import { GrantView } from "@/features/grant-view/grant-view";

export function ViewRoute() {
  return (
    <PublicPage minimal footer={false} className="safe-bottom mx-auto max-w-3xl px-4 pt-6 sm:px-6">
      <GrantView />
    </PublicPage>
  );
}
