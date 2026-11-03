// The page's security headers (README.md#the-ui): a strict Content-Security-Policy on everything the
// Worker serves from its assets. Only the app's own scripts run (no inline script, no eval); styles may
// be inline, since Mantine sets CSS variables in `style` attributes and a <style> tag of its own; the
// API, the live trace's WebSocket and every other fetch go to this origin only; nothing may frame the
// page. `vite dev` serves its own inline preamble and HMR client, so the Worker skips it there.

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:", // Vite inlines the smallest font subsets as data: URLs
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/** An asset's response with the page's security headers. */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("content-security-policy", CSP);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "no-referrer");
  return out;
}
