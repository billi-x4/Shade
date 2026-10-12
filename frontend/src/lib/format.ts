const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "42 min", "3 h 5 min", "2 days" — for countdowns and lags. */
export function formatSpan(ms: number): string {
  const span = Math.max(0, ms);
  if (span < MINUTE) return plural(Math.ceil(span / 1000), "second");
  if (span < HOUR) return `${Math.ceil(span / MINUTE)} min`;
  if (span < DAY) {
    const hours = Math.floor(span / HOUR);
    const minutes = Math.floor((span % HOUR) / MINUTE);
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  return plural(Math.floor(span / DAY), "day");
}

/** "5 min ago", "just now", "in 3 days". */
export function formatRelative(iso: string, now: number): string {
  const delta = new Date(iso).getTime() - now;
  if (Math.abs(delta) < MINUTE) return "just now";
  return delta > 0 ? `in ${formatSpan(delta)}` : `${formatSpan(-delta)} ago`;
}

/**
 * How long to wait before retrying, for prose ("Wait about 57 minutes"): exact seconds under a
 * minute, then a rounded "about …" in minutes, hours or days.
 */
export function formatWait(seconds: number): string {
  const span = Math.max(0, Math.ceil(seconds));
  if (span < 60) return plural(span, "second");
  if (span < 3_600) return `about ${plural(Math.ceil(span / 60), "minute")}`;
  if (span < 86_400) return `about ${plural(Math.round(span / 3_600), "hour")}`;
  return `about ${plural(Math.round(span / 86_400), "day")}`;
}

/** Durations offered as presets: "10 minutes", "1 day", "7 days". */
export function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds % 3_600 === 0) return plural(seconds / 3_600, "hour");
  return plural(Math.round(seconds / 60), "minute");
}

export function truncateMiddle(value: string, keep = 8): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
