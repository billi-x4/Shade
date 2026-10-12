import type { ReactNode } from "react";
import { PublicPage } from "@/components/site-header";
import { useDocumentTitle } from "@/lib/hooks";

export function AuthLayout({
  title,
  documentTitle,
  intro,
  children,
}: {
  title: string;
  documentTitle: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  useDocumentTitle(documentTitle);
  return (
    <PublicPage className="px-4 py-10 sm:px-6 sm:py-16">
      <div className="mx-auto w-full max-w-md space-y-8">
        <div className="space-y-3">
          <h1 className="font-serif text-4xl leading-tight">{title}</h1>
          {intro ? <div className="text-muted">{intro}</div> : null}
        </div>
        {children}
      </div>
    </PublicPage>
  );
}

/** Form-level outcome line: errors in bad, notices in ok. Announced politely. */
export function FormMessage({ error, notice }: { error?: string | null; notice?: string | null }) {
  return (
    <p role="status" aria-live="polite" className="text-sm">
      {error ? (
        <span className="text-bad">{error}</span>
      ) : notice ? (
        <span className="text-ok">{notice}</span>
      ) : null}
    </p>
  );
}
