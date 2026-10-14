import { useCallback, useId, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { Modal } from "@/components/modal";
import { SecretContext, type RevealSecret, type Secret } from "@/features/desk/desk-context";

type QueuedSecret = Secret & { id: number };

interface SecretQueue {
  /** Waiting to be saved, oldest first; the first one is on screen. */
  waiting: QueuedSecret[];
  /** Saved since the queue was last empty, for "2 of 3". */
  saved: number;
}

/**
 * Shown-once values (API keys, grant links, webhook secrets) open in one modal owned by the desk
 * shell, so list refetches and other rows never wipe them. Only "I saved it" closes it. Values
 * revealed while one is on screen (two creations in flight at once) wait their turn rather than
 * replace it, so none is lost unseen.
 */
export function SecretProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<SecretQueue>({ waiting: [], saved: 0 });
  const nextId = useRef(0);
  const titleId = useId();
  const introId = useId();
  const positionId = useId();

  const reveal = useCallback<RevealSecret>((secret) => {
    nextId.current += 1;
    const queued = { ...secret, id: nextId.current };
    setQueue((current) => ({ ...current, waiting: [...current.waiting, queued] }));
  }, []);

  function onSaved(event: MouseEvent) {
    // The second click of a double-click would land on the next secret's own "I saved it".
    if (event.detail > 1) return;
    setQueue((current) => {
      const waiting = current.waiting.slice(1);
      return { waiting, saved: waiting.length > 0 ? current.saved + 1 : 0 };
    });
  }

  const secret = queue.waiting[0];
  const total = queue.saved + queue.waiting.length;
  const position = total > 1 ? `${queue.saved + 1} of ${total}` : null;

  return (
    <SecretContext.Provider value={reveal}>
      {children}
      {/* Keyed per secret: the next one opens as a new dialog, so it is announced, focus starts on
          its first control (not on "I saved it") and no "Copied" state carries over. */}
      <Modal
        key={secret?.id ?? 0}
        open={secret !== undefined}
        labelledBy={position ? `${titleId} ${positionId}` : titleId}
        describedBy={introId}
      >
        {secret ? (
          <div>
            <div className="space-y-6 p-6 pb-5">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 font-mono text-[0.7rem] tracking-[0.14em] uppercase">
                  <p className="flex items-center gap-2.5 text-faint">
                    <span aria-hidden className="h-1 w-6 rounded-[1px] bg-glow" />
                    Shown once
                  </p>
                  {position ? (
                    <p id={positionId} className="text-muted tabular">
                      {position}
                    </p>
                  ) : null}
                </div>
                <h2 id={titleId} className="font-display text-3xl leading-tight wrap-anywhere">
                  {secret.title}
                </h2>
                <div id={introId} className="text-sm text-muted">
                  {secret.intro}
                </div>
              </div>
              <div className="space-y-5">
                {secret.items.map((item) => (
                  <div key={item.label} className="space-y-2">
                    <p className="font-mono text-[0.7rem] tracking-[0.14em] text-faint uppercase">
                      {item.label}
                    </p>
                    {/* On paper: the value reads like a slip handed over once. */}
                    <div className="on-paper rounded-sm px-4 py-3 shadow-[0_12px_30px_-18px_var(--color-glow)]">
                      <code
                        className={
                          item.block
                            ? "block font-mono text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap"
                            : "block font-mono text-sm leading-relaxed wrap-anywhere"
                        }
                      >
                        {item.value}
                      </code>
                    </div>
                    <CopyButton value={item.value} label={`Copy ${item.label.toLowerCase()}`} />
                  </div>
                ))}
              </div>
              {secret.notes?.length ? (
                <ul className="space-y-2.5 border-t border-line pt-5 text-sm text-muted">
                  {secret.notes.map((note, index) => (
                    <li key={index} className="flex gap-3">
                      <span
                        aria-hidden
                        className="mt-2.5 h-[3px] w-3 shrink-0 rounded-[1px] bg-line-strong"
                      />
                      <span className="min-w-0">{note}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {/* Stays in view while a long secret scrolls: the one way out is always visible. */}
            <div className="sticky bottom-0 flex flex-col gap-3 border-t border-line bg-surface px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-faint">Shade cannot show it again after you close this.</p>
              <Button onClick={onSaved} className="w-full shrink-0 sm:w-auto">
                I saved it
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </SecretContext.Provider>
  );
}
