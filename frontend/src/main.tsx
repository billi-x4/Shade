import "@fontsource-variable/figtree";
import "@fontsource-variable/newsreader/opsz.css";
import "./styles.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { qk } from "@/api/keys";
import { createQueryClient } from "@/api/query-client";
import { createAppRouter } from "./router";

const queryClient = createQueryClient({
  onUnauthorized: () => {
    queryClient.removeQueries({ queryKey: qk.session });
    queryClient.removeQueries({ queryKey: qk.desk });
    const { pathname } = router.state.location;
    if (pathname.startsWith("/desk"))
      void router.navigate({ to: "/login", search: { redirect: pathname } });
  },
  onEmailUnverified: () => {
    void router.navigate({ to: "/verify-email" });
  },
});

const router = createAppRouter(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
