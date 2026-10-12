import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { qrModulesPath } from "@/lib/qr";

/**
 * QR rendered as a React SVG element from the module matrix (no innerHTML). Dark on paper so phone
 * cameras lock on quickly.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const qr = useMemo(() => qrModulesPath(value), [value]);
  if (!qr) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      className={cn("block h-auto w-full", className)}
    >
      <rect width={qr.size} height={qr.size} fill="#f4f3f1" />
      <path d={qr.d} fill="#0e0e10" />
    </svg>
  );
}
