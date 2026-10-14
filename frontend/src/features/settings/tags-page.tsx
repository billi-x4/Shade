import { COPY } from "@shade/contract";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "@/api/client";
import { createTag, meQuery, tagsQuery } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { Field, TextInput } from "@/components/field";
import { NetworkBadge } from "@/components/mark";
import { EmptyState, ErrorState, LoadingState, RefreshError } from "@/components/states";
import { ActionStatus } from "@/features/desk/action-status";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { SettingsSection } from "@/features/settings/settings-layout";
import { Eyebrow, SettingsRow } from "@/features/settings/settings-row";
import { formatDateTime } from "@/lib/format";
import { checkTagName, normalizeTagName } from "@/lib/validation";

/** Names per shop across networks (backend services/tags.ts, MAX_TAGS_PER_MERCHANT). */
const TAG_LIMIT = 5;

function TagForm() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const mutation = useDeskMutation({
    mutationFn: createTag,
    invalidate: () => [qk.tags],
    success: (tag) => `${tag.display} is yours.`,
    onSuccess: () => setName(""),
  });
  const serverError =
    mutation.error instanceof ApiError &&
    ["BAD_TAG", "TAG_TAKEN", "TAG_LIMIT"].includes(mutation.error.code)
      ? mutation.error.message
      : null;
  // Same normalisation as the backend: "Northline.shade" claims "northline".
  const preview = normalizeTagName(name);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = checkTagName(name, { required: true });
    setError(next);
    if (next) {
      ref.current?.focus();
      return;
    }
    mutation.mutate(preview);
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <Field
        label="Name"
        hint="Up to 32 lowercase letters, digits and hyphens. A hyphen cannot start or end it."
        error={error ?? serverError}
      >
        {(control) => (
          <div className="flex items-stretch">
            <TextInput
              {...control}
              ref={ref}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="rounded-r-none font-mono"
              placeholder="northline"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <span
              aria-hidden
              className="flex shrink-0 items-center rounded-r-sm border border-l-0 border-line-strong bg-surface-2 px-3 font-mono text-sm text-muted"
            >
              .shade
            </span>
          </div>
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" variant="ghost" disabled={mutation.isPending} className="max-w-full">
          <span className="truncate">
            {mutation.isPending ? "Claiming…" : `Claim ${preview || "name"}.shade`}
          </span>
        </Button>
        {serverError ? null : <ActionStatus mutation={mutation} />}
      </div>
    </form>
  );
}

export function TagsSettingsPage() {
  const me = useQuery(meQuery);
  const tags = useQuery(tagsQuery);
  const network = me.data?.merchant.network;
  const noAddress = me.data && network ? !me.data.merchant.receive_addresses[network] : false;
  return (
    <SettingsSection
      title="Tags"
      intro="A tag is a short name, like northline.shade, that points to your Unified Address. Anyone can look it up through Shade to find where to pay you."
    >
      <div className="space-y-10">
        <SettingsRow
          index={0}
          title="Claim a name"
          note={`Each shop can hold ${TAG_LIMIT} names. A new name points to the desk's current network.`}
        >
          {noAddress ? (
            <p className="flex gap-2.5 text-sm text-warn">
              <span aria-hidden className="mt-1.5 h-2.5 w-1 shrink-0 rounded-[1px] bg-warn" />
              {COPY.noAddress}
            </p>
          ) : (
            <TagForm />
          )}
        </SettingsRow>
        <SettingsRow
          index={1}
          title="Your names"
          note={
            tags.data ? (
              <>
                <span className="block font-display text-4xl leading-none text-fg tabular">
                  {tags.data.length}
                  <span className="text-faint">
                    <span aria-hidden>/</span>
                    <span className="sr-only"> of </span>
                    {TAG_LIMIT}
                  </span>
                </span>
                <span className="mt-1 block">claimed</span>
              </>
            ) : undefined
          }
        >
          {tags.isRefetchError && tags.data ? (
            <RefreshError error={tags.error} onRetry={() => void tags.refetch()} />
          ) : null}
          {tags.data === undefined ? (
            tags.isError ? (
              <ErrorState error={tags.error} onRetry={() => void tags.refetch()} />
            ) : (
              <LoadingState label="Loading tags…" rows={1} />
            )
          ) : tags.data.length === 0 ? (
            <EmptyState title="No tags yet.">
              Claim a name to share it in place of your full address.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {tags.data.map((tag) => (
                <li
                  key={tag.id}
                  className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-6 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1 basis-64 space-y-3">
                    <p className="font-display text-3xl leading-none wrap-anywhere">
                      {tag.display}
                    </p>
                    {/* Never abridged: ZIP-316 requires at least the first 20 characters of a UA. */}
                    {tag.address ? (
                      <div className="space-y-1">
                        <Eyebrow>Points to</Eyebrow>
                        <p className="font-mono text-xs leading-relaxed text-muted wrap-anywhere">
                          {tag.address}
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-warn">
                        No {tag.network} receive address, so this name does not resolve.
                      </p>
                    )}
                    <p className="text-xs text-faint">Since {formatDateTime(tag.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <NetworkBadge network={tag.network} />
                    <CopyButton
                      value={tag.display}
                      label="Copy tag"
                      variant="quiet"
                      className="px-2"
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
      </div>
    </SettingsSection>
  );
}
