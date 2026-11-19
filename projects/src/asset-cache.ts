// How long the browser keeps what the Worker serves from its assets (README.md#the-ui). `vite build` names
// every file it writes under /assets/ by its content (`<name>-<8-character hash>.<ext>`: the scripts, the
// stylesheets, the fonts), so a file at such a path never changes: the browser keeps it for a year without
// asking again. Everything else (index.html, which every navigation path falls back to, and the unhashed
// files from public/, such as /scheme.js) is revalidated on each load, so a deploy reaches an open tab's
// next load.
//
// `private`: the app is behind Cloudflare Access, so no shared cache may keep its files; only the browser.

/** A file `vite build` named by its content: under /assets/, the name's last `-` part an 8-character hash. */
const HASHED = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

export const IMMUTABLE = "private, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

/**
 * The `cache-control` of an asset answer: immutable only for a `200` with a hashed file's body. A `304`,
 * a `404` or any other status, and an HTML body (the single-page fallback answers a missing file with
 * index.html and a `200`, as after a deploy removed an old chunk) are revalidated.
 */
export function assetCacheControl(path: string, status: number, contentType: string | null): string {
  if (status === 200 && HASHED.test(path) && !/^text\/html\b/i.test(contentType ?? "")) return IMMUTABLE;
  return REVALIDATE;
}
