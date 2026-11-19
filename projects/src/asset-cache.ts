// How long the browser keeps what the Worker serves from its assets (README.md#the-ui). `vite build` names
// every file it writes under /assets/ by its content (`<name>-<8-character hash>.<ext>`: the scripts, the
// stylesheets, the fonts), so a file at such a path never changes: the browser keeps it for a year without
// asking again. Everything else (index.html, which every navigation path falls back to, and the unhashed
// files from public/, such as /scheme.js) is revalidated on each load, so a deploy reaches an open tab's
// next load.
//
// `private`: the app is behind Cloudflare Access, so no shared cache may keep its files; only the browser.

/**
 * A file `vite build` named by its content: under /assets/, the name's last `-` part an 8-character hash.
 * Only Vite writes there: nothing goes in public/assets/, whose files would be served unhashed at these paths.
 */
const HASHED = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

export const IMMUTABLE = "private, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

/**
 * The `cache-control` of an asset answer: immutable for a hashed file's `200`, and for its `304` too. A
 * browser stores a 304's headers in place of the ones it held (RFC 9111 §4.3.4), and one that fetched the
 * file before this rule (with Workers Assets' `max-age=0, must-revalidate`) learns it is immutable only
 * that way; a 304 at a content-named path confirms the copy it holds is that file. A `404` or any other
 * status, and an HTML body (the single-page fallback answers a missing file with index.html and a `200`,
 * as after a deploy removed an old chunk) are revalidated.
 */
export function assetCacheControl(path: string, status: number, contentType: string | null): string {
  if ((status === 200 || status === 304) && HASHED.test(path) && !/^text\/html\b/i.test(contentType ?? "")) return IMMUTABLE;
  return REVALIDATE;
}
