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
          <div className="space-y-5 p-6">
            <div className="space-y-2">
              <h2 id={titleId} className="font-serif text-2xl leading-tight">
                {secret.title}
              </h2>
              {position ? (
                <p id={positionId} className="text-sm text-muted tabular">
                  {position}
                </p>
              ) : null}
              <div id={introId} className="text-sm text-muted">
                {secret.intro}
              </div>
            </div>
            <div className="space-y-4">
              {secret.items.map((item) => (
                <div key={item.label} className="space-y-2">
                  <p className="text-sm font-medium">{item.label}</p>
                  <div className="on-paper rounded-sm p-3">
                    <code
                      className={
                        item.block
                          ? "block font-mono text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap"
                          : "block font-mono text-sm wrap-anywhere"
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
              <ul className="space-y-2 border-t border-line pt-4 text-sm text-muted">
                {secret.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex justify-end border-t border-line pt-4">
              <Button onClick={onSaved}>I saved it</Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </SecretContext.Provider>
  );
}
