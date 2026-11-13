// Times as the page shows them: relative when recent, a date otherwise; the exact time in a title.

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ago(ms: number, now = Date.now()): string {
  const s = Math.round((ms - now) / 1000);
  if (Math.abs(s) < 45) return "just now";
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, "minute");
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(h, "hour");
  const d = Math.round(h / 24);
  if (Math.abs(d) < 7) return rtf.format(d, "day");
  return full.format(ms);
}

export const exact = (ms: number) => full.format(ms);

const clockFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });
/** The time of day, to the second ("1:47:05 AM"): for "as of" a moment that's recent but not now. */
export const clock = (ms: number) => clockFormat.format(ms);
