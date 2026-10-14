import { PublicPage } from "@/components/site-header";
import { GrantView } from "@/features/grant-view/grant-view";

/** The proof side is paper: theme-paper flips every token, header included, edge to edge. */
export function ViewRoute() {
  return (
    <div className="theme-paper min-h-dvh">
      <PublicPage
        minimal
        footer={false}
        className="safe-bottom mx-auto max-w-5xl px-4 pt-8 sm:px-6 sm:pt-14"
      >
        <GrantView />
      </PublicPage>
    </div>
  );
}
