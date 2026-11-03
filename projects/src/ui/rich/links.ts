// What a message's links and images may point to (README.md#rich-messages): links only http:, https:,
// mailto: (and task: references, resolved on the board); images only data: URLs of raster images (no remote image: no tracking pixel).

export const LINK = /^(https?:|mailto:)/i;
export const INLINE_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** react-markdown's `urlTransform`: a safe URL, or "" (rendered as text, not as a link or image). */
export function urlTransform(url: string, key: string): string {
  const u = url.trim();
  if (key === "src") return INLINE_IMAGE.test(u) ? u : LINK.test(u) ? u : "";
  // `task:` links are resolved against the board by the renderer (rich/tasks.ts), never followed.
  if (key === "href") return LINK.test(u) || /^task:tsk_[a-z0-9]+$/.test(u) ? u : "";
  return "";
}
