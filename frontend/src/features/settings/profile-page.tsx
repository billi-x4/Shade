import type { Me } from "@shade/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FormEvent } from "react";
import { meQuery, saveProfile } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { Field, TextInput } from "@/components/field";
import { ErrorState, LoadingState } from "@/components/states";
import { ActionStatus } from "@/features/desk/action-status";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { SettingsSection } from "@/features/settings/settings-layout";
import { Eyebrow, SettingsRow } from "@/features/settings/settings-row";
import { DISPLAY_NAME_MAX } from "@/lib/validation";

function ProfileForm({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.merchant.display_name);
  const [error, setError] = useState<string | null>(null);
  const mutation = useDeskMutation({
    mutationFn: saveProfile,
    success: () => "Shop name saved.",
    onSuccess: (next) => queryClient.setQueryData<Me>(qk.me, next),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    const next =
      value.length > DISPLAY_NAME_MAX ? `Keep it under ${DISPLAY_NAME_MAX + 1} characters.` : null;
    setError(next);
    if (!next) mutation.mutate(value);
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <Field
        label="Shop name"
        hint="Leave it empty to show no name."
        error={error}
        aside={
          <span className="font-mono text-xs text-faint tabular">
            {name.trim().length}/{DISPLAY_NAME_MAX}
          </span>
        }
      >
        {(control) => (
          <TextInput
            {...control}
            autoComplete="organization"
            placeholder="Northline Coffee"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" variant="ghost" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
        <ActionStatus mutation={mutation} successText="Saved." />
      </div>
    </form>
  );
}

export function ProfileSettingsPage() {
  const me = useQuery(meQuery);
  return (
    <SettingsSection title="Profile" intro="The name payers see, and the email you sign in with.">
      {me.data === undefined ? (
        me.isError ? (
          <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        ) : (
          <LoadingState label="Loading your profile…" rows={1} />
        )
      ) : (
        <div className="space-y-10">
          <SettingsRow
            index={0}
            title="Pay pages"
            note="Payers see your shop name on every pay page."
          >
            <ProfileForm me={me.data} />
          </SettingsRow>
          <SettingsRow index={1} title="Account">
            <div className="space-y-1">
              <Eyebrow>Signed in as</Eyebrow>
              <p className="text-lg wrap-anywhere">{me.data.user.email}</p>
            </div>
          </SettingsRow>
        </div>
      )}
    </SettingsSection>
  );
}
