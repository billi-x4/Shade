import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAnnounce } from "@/components/announcer-context";
import { buttonClass, type ButtonVariant } from "@/components/button-styles";
import { copyText } from "@/lib/browser";
import { cn } from "@/lib/cn";

type CopyState = "idle" | "copied" | "failed";

export function CopyButton({
  value,
  label = "Copy",
  variant = "ghost",
  className,
}: {
  value: string;
  label?: string;
  variant?: ButtonVariant;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  const announce = useAnnounce();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onCopy() {
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    announce(ok ? "Copied." : "Could not copy. Select the text and copy it by hand.");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), ok ? 1600 : 4000);
  }

  return (
    <button
      type="button"
      className={cn(buttonClass(variant), className)}
      onClick={() => void onCopy()}
    >
      {state === "copied" ? (
        <Check aria-hidden size={16} strokeWidth={1.75} />
      ) : (
        <Copy aria-hidden size={16} strokeWidth={1.75} />
      )}
      <span>{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}</span>
    </button>
  );
}
