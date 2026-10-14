import { COPY } from "@shade/contract";
import type { CSSProperties, ReactNode } from "react";
import { PublicPage } from "@/components/site-header";
import { useDocumentTitle } from "@/lib/hooks";

/** COPY.tagline as three lines; the middle one ("Prove in the light.") is lit. */
const TAGLINE_LINES = COPY.tagline.split(/(?<=\.)\s+/);

/** Decorative panel beside the auth forms on wide screens: light through blinds, the tagline. */
function AuthArt() {
  return (
    <div
      aria-hidden
      className="relative hidden min-h-[30rem] overflow-hidden rounded-lg border border-line bg-surface lg:block"
    >
      <span className="blinds blinds-fade absolute inset-0 -rotate-6 scale-125 opacity-[0.16]" />
      <div className="absolute inset-x-8 bottom-8 space-y-1 font-display text-5xl leading-[0.95]">
        {TAGLINE_LINES.map((line, index) => (
          <p
            key={line}
            className={
              index === 1
                ? "slat-open w-fit rounded-[2px] bg-glow px-2 text-ink"
                : "slat-open text-fg"
            }
            style={{ "--i": index } as CSSProperties}
          >
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

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
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-20">
        <div className="mx-auto w-full max-w-md space-y-8 lg:col-start-2 lg:row-start-1">
          <div className="space-y-3">
            <span aria-hidden className="slat-open block h-1 w-12 rounded-[1px] bg-glow" />
            <h1 className="font-display text-5xl leading-[0.95]">{title}</h1>
            {intro ? <div className="text-muted">{intro}</div> : null}
          </div>
          {children}
        </div>
        <div className="lg:col-start-1 lg:row-start-1">
          <AuthArt />
        </div>
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
