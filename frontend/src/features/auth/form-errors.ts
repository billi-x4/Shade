/**
 * What a screen reader hears after a client-side check fails: the first problem, plus how many
 * more fields need fixing. Focus moves to the first invalid field as well.
 */
export function fieldErrorSummary(errors: (string | null | undefined)[]): string | null {
  const found = errors.filter((error): error is string => Boolean(error));
  const [first] = found;
  if (!first) return null;
  const more = found.length - 1;
  return more === 0
    ? first
    : `${first} ${more === 1 ? "One more field needs" : `${more} more fields need`} fixing.`;
}
