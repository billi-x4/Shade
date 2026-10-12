import { getRouteApi } from "@tanstack/react-router";
import { PublicPage } from "@/components/site-header";
import { PayView } from "@/features/pay/pay-view";

const route = getRouteApi("/pay/$id");

export function PayRoute() {
  const { id } = route.useParams();
  return (
    <PublicPage minimal footer={false} className="safe-bottom mx-auto max-w-md px-4 pt-2 sm:px-6">
      <PayView id={id} />
    </PublicPage>
  );
}
