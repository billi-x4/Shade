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
import { formatDateTime } from "@/lib/format";
import { checkTagName, normalizeTagName } from "@/lib/validation";

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
        hint="Lowercase letters, digits and hyphens (not at the start or end). Anyone can look it up to find your address."
        error={error ?? serverError}
      >
        {(control) => (
          <div className="flex items-center gap-2">
            <TextInput
              {...control}
              ref={ref}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="northline"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <span aria-hidden className="shrink-0 text-muted">
              .shade
            </span>
          </div>
        )}
      </Field>
      <Button type="submit" variant="ghost" disabled={mutation.isPending} className="max-w-full">
        <span className="truncate">
          {mutation.isPending ? "Claiming…" : `Claim ${preview || "name"}.shade`}
        </span>
      </Button>
      {serverError ? null : <ActionStatus mutation={mutation} />}
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
      intro="A tag is a short name, like northline.shade, that points at your Unified Address. Up to five."
    >
      {noAddress ? <p className="text-sm text-warn">{COPY.noAddress}</p> : <TagForm />}
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
        <EmptyState title="No tags yet." />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {tags.data.map((tag) => (
            <li
              key={tag.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4"
            >
              <div className="min-w-0 space-y-1">
                <p className="font-serif text-xl wrap-anywhere">{tag.display}</p>
                {/* Never abridged: ZIP-316 requires at least the first 20 characters of a UA. */}
                {tag.address ? (
                  <p className="font-mono text-xs text-muted wrap-anywhere">
                    <span className="sr-only">Resolves to </span>
                    {tag.address}
                  </p>
                ) : (
                  <p className="text-xs text-warn">
                    No {tag.network} receive address, so this name does not resolve.
                  </p>
                )}
                <p className="text-xs text-faint">Since {formatDateTime(tag.created_at)}</p>
              </div>
              <div className="flex items-center gap-2">
                <NetworkBadge network={tag.network} />
                <CopyButton value={tag.display} label="Copy tag" variant="quiet" className="px-2" />
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
