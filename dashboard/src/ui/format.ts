// How the page writes ids and times.

/** `hst_01m5…bgn6gq` reads better than the whole id; the title holds the full one. */
export const short = (id: string | null | undefined) => (id ? `${id.slice(0, 4)}…${id.slice(-6)}` : "");

/** `3d 4h`, `5h 2m`, `40m`, `12s`. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** How long ago `ms` was; empty when there is no time. */
export const age = (ms: number | null | undefined, now: number) => (ms ? span(now - ms) : "");

export const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : undefined);

/** MiB as GiB with one decimal. */
export const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;
