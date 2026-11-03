// The page's Content-Security-Policy (README.md#rich-messages): scripts, connections, fonts and images
// only from the app itself (and data: images, which the SVG figures and inline rasters are). Styles may
// be inline: Mantine writes its CSS variables in a <style> element and its style props as style
// attributes, and KaTeX sizes with style attributes. The trace's WebSocket is the app's own origin.

export function contentSecurityPolicy(url: URL): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' wss://${url.host}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** The response with the policy, when it's a page (HTML); anything else as it is. */
export function withCsp(res: Response, url: URL): Response {
  if (!(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  const out = new Response(res.body, res);
  out.headers.set("content-security-policy", contentSecurityPolicy(url));
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "same-origin");
  return out;
}
