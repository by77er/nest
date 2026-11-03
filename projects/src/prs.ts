// A PR as the owner names it (README.md#prs): pure, so the Worker and the page's picker read it alike.

/** A PR's number from what the owner gave: `12`, `#12`, or the PR's URL on this repo. */
export function prNumberOf(v: number | string, repo: string): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
  const t = v.trim();
  const n = /^#?([1-9][0-9]{0,9})$/.exec(t)?.[1];
  if (n) return Number(n);
  const u = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]{0,9})\/?(?:[#?].*)?$/i.exec(t);
  return u && u[1]!.toLowerCase() === repo.toLowerCase() ? Number(u[2]) : null;
}
